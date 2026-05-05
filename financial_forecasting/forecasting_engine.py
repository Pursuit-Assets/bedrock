"""Forecasting engine for financial predictions and analysis."""

import asyncio
import uuid
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime, date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from collections import defaultdict
import statistics
import logging

from models import (
    SalesforceOpportunity, SalesforceAccount, IntacctInvoice, IntacctPayment,
    PaymentForecast, CashFlowProjection, ForecastingMetrics, ForecastingReport,
    ForecastScenario, ForecastingDashboardData, OpportunityStage, PaymentTerms,
    OPEN_STAGES, CLOSED_STAGES, WON_STAGES_SET, LOST_STAGES_SET,
)
from security import escape_soql_string

logger = logging.getLogger(__name__)


# ── Pure calculation functions (no I/O, easy to test) ────────────────────────

def calculate_weighted_pipeline(opportunities: List[Dict[str, Any]]) -> Decimal:
    """Sum of amount * probability for a list of raw opportunity dicts."""
    return sum(
        Decimal(str(opp.get("Amount", 0))) * (Decimal(str(opp.get("Probability", 0))) / 100)
        for opp in opportunities
    )


def calculate_expected_revenue_in_window(
    opportunities: List[Dict[str, Any]],
    today: date,
    days: int,
) -> Decimal:
    """Weighted revenue from opportunities closing within `days` of `today`."""
    cutoff = today + timedelta(days=days)
    total = Decimal('0')
    for opp in opportunities:
        close_str = opp.get("CloseDate")
        if not close_str:
            continue
        close = datetime.strptime(close_str, '%Y-%m-%d').date()
        if close <= cutoff:
            amount = Decimal(str(opp.get("Amount", 0)))
            prob = Decimal(str(opp.get("Probability", 0))) / 100
            total += amount * prob
    return total


def identify_risk_factors(
    opp: Dict[str, Any],
    stage: OpportunityStage,
    close_date: date,
    amount: Decimal,
    account_win_rate: Optional[float],
    today: date,
) -> List[str]:
    """Pure risk-factor identification — no I/O."""
    risks: List[str] = []
    days_to_close = (close_date - today).days

    if days_to_close < 0:
        risks.append("Overdue close date")
    elif days_to_close < 7:
        risks.append("Close date within 1 week")

    if stage in [OpportunityStage.LEAD_GEN, OpportunityStage.NEW_LEAD, OpportunityStage.QUALIFYING] and days_to_close < 30:
        risks.append("Early stage with near-term close date")

    if amount > Decimal('100000'):
        risks.append("Large deal size")

    if account_win_rate is not None and account_win_rate < 0.3:
        risks.append("Low historical win rate for account")

    payment_terms_str = opp.get("Payment_Terms__c", "Net 30")
    if payment_terms_str in ["Net 60", "Net 90"]:
        risks.append("Extended payment terms")

    return risks


# ── Configuration / Assumptions ──────────────────────────────────────────────

class ForecastAssumptions:
    """Explicit assumptions used when real data is unavailable.

    Every number here is a best-guess default.  Making them visible (rather than
    hiding them inside helper methods) lets callers know where real data ends and
    assumptions begin.
    """
    DEFAULT_CASH_POSITION = Decimal('50000')
    DEFAULT_MONTHLY_EXPENSES = Decimal('25000')
    DEFAULT_AVG_PAYMENT_DELAY_DAYS = 8
    DEFAULT_CASH_CONVERSION_CYCLE_DAYS = 45
    DEFAULT_COLLECTION_RATE = 0.85


class ForecastingEngine:
    """Core forecasting engine for financial predictions."""
    
    def __init__(self, mcp_client):
        self.mcp_client = mcp_client
        self.historical_data_cache = {}
        self.last_cache_update = None
        
        # Forecasting parameters — stage probabilities reflect Pursuit's pipeline
        self.stage_probabilities = {
            OpportunityStage.NONE: 0.0,
            OpportunityStage.LEAD_GEN: 0.05,
            OpportunityStage.NEW_LEAD: 0.10,
            OpportunityStage.QUALIFYING: 0.20,
            OpportunityStage.ASK_IN_PROGRESS: 0.40,
            OpportunityStage.PROPOSAL_SUBMITTED: 0.55,
            OpportunityStage.CONTRACT_CREATION: 0.70,
            OpportunityStage.CONTRACTING: 0.80,
            OpportunityStage.COLLECTING: 0.95,
            OpportunityStage.CLOSED_COMPLETED: 1.0,
            OpportunityStage.CLOSED_DID_NOT_FULFILL: 0.0,
            OpportunityStage.CLOSED_LOST: 0.0,
            OpportunityStage.WITHDRAWN: 0.0,
        }
        
        self.payment_term_days = {
            PaymentTerms.IMMEDIATE: 0,
            PaymentTerms.NET_15: 15,
            PaymentTerms.NET_30: 30,
            PaymentTerms.NET_45: 45,
            PaymentTerms.NET_60: 60,
            PaymentTerms.NET_90: 90,
            PaymentTerms.COD: 0,
        }
        
        # Historical collection rates by payment terms (can be learned from data)
        self.collection_rates = {
            PaymentTerms.IMMEDIATE: 0.95,
            PaymentTerms.NET_15: 0.92,
            PaymentTerms.NET_30: 0.88,
            PaymentTerms.NET_45: 0.85,
            PaymentTerms.NET_60: 0.82,
            PaymentTerms.NET_90: 0.78,
            PaymentTerms.COD: 0.98,
        }
        
        # Average payment delays by terms (days beyond due date)
        self.average_payment_delays = {
            PaymentTerms.IMMEDIATE: 2,
            PaymentTerms.NET_15: 5,
            PaymentTerms.NET_30: 8,
            PaymentTerms.NET_45: 12,
            PaymentTerms.NET_60: 15,
            PaymentTerms.NET_90: 20,
            PaymentTerms.COD: 1,
        }

    async def _refresh_cache_if_needed(self):
        """Refresh historical data cache if needed."""
        if (not self.last_cache_update or 
            datetime.now() - self.last_cache_update > timedelta(hours=1)):
            await self._load_historical_data()

    async def _load_historical_data(self):
        """Load historical data for analysis."""
        try:
            logger.info("Loading historical data for forecasting...")
            
            # Load Salesforce data
            salesforce = self.mcp_client.salesforce
            
            # Get closed opportunities from last 2 years for historical analysis
            two_years_ago = (date.today() - timedelta(days=730)).strftime('%Y-%m-%d')
            closed_list = ", ".join(f"'{escape_soql_string(s)}'" for s in sorted(WON_STAGES_SET | LOST_STAGES_SET))

            closed_opps_query = f"""
            SELECT Id, AccountId, Name, StageName, Amount, Probability, CloseDate,
                   CreatedDate, Payment_Terms__c, Contract_Start_Date__c
            FROM Opportunity
            WHERE CloseDate >= {two_years_ago} AND StageName IN ({closed_list})
            ORDER BY CloseDate DESC
            LIMIT 1000
            """
            
            closed_opps_result = await salesforce.query(closed_opps_query)
            
            # Load Sage Intacct data
            intacct = self.mcp_client.sage_intacct
            
            # Get invoices and payments from last year
            one_year_ago = (date.today() - timedelta(days=365)).strftime('%Y-%m-%d')
            
            invoices_result = await intacct.get_invoices(limit=1000)
            payments_result = await intacct.get_payments(limit=1000)
            
            # Cache the data
            self.historical_data_cache = {
                "closed_opportunities": closed_opps_result.get("records", []),
                "invoices": invoices_result.get("data", []) if invoices_result.get("success") else [],
                "payments": payments_result.get("data", []) if payments_result.get("success") else [],
                "loaded_at": datetime.now()
            }
            
            self.last_cache_update = datetime.now()
            logger.info(f"Loaded historical data: {len(self.historical_data_cache['closed_opportunities'])} opportunities, "
                       f"{len(self.historical_data_cache['invoices'])} invoices, "
                       f"{len(self.historical_data_cache['payments'])} payments")
            
        except Exception as e:
            logger.error(f"Error loading historical data: {e}")
            # Use empty cache if loading fails
            self.historical_data_cache = {
                "closed_opportunities": [],
                "invoices": [],
                "payments": [],
                "loaded_at": datetime.now()
            }

    async def generate_payment_forecasts(
        self, 
        days_ahead: int = 90, 
        min_probability: int = 0
    ) -> List[PaymentForecast]:
        """Generate payment forecasts for open opportunities."""
        await self._refresh_cache_if_needed()
        
        try:
            # Get open opportunities
            salesforce = self.mcp_client.salesforce
            
            closed_list = ", ".join(f"'{escape_soql_string(s)}'" for s in sorted(WON_STAGES_SET | LOST_STAGES_SET))
            open_opps_query = f"""
            SELECT Id, AccountId, Account.Name, Name, StageName, Amount, Probability,
                   CloseDate, Payment_Terms__c, Contract_Start_Date__c
            FROM Opportunity
            WHERE StageName NOT IN ({closed_list})
            AND Probability >= {min_probability}
            AND CloseDate <= {(date.today() + timedelta(days=days_ahead)).strftime('%Y-%m-%d')}
            ORDER BY CloseDate ASC
            """
            
            result = await salesforce.query(open_opps_query)
            opportunities = result.get("records", [])
            
            forecasts = []
            
            for opp in opportunities:
                try:
                    # Parse opportunity data
                    opp_id = opp["Id"]
                    account_id = opp["AccountId"]
                    account_name = opp.get("Account", {}).get("Name", "Unknown")
                    opp_name = opp["Name"]
                    stage_name = OpportunityStage(opp["StageName"])
                    amount = Decimal(str(opp["Amount"] or 0))
                    probability = int(opp["Probability"] or 0)
                    close_date = datetime.strptime(opp["CloseDate"], '%Y-%m-%d').date()
                    
                    # Determine payment terms
                    payment_terms_str = opp.get("Payment_Terms__c", "Net 30")
                    try:
                        payment_terms = PaymentTerms(payment_terms_str)
                    except ValueError:
                        payment_terms = PaymentTerms.NET_30  # Default
                    
                    # Calculate expected payment date
                    payment_days = self.payment_term_days.get(payment_terms, 30)
                    average_delay = self.average_payment_delays.get(payment_terms, 8)
                    expected_payment_date = close_date + timedelta(days=payment_days + average_delay)
                    
                    # Calculate expected amount
                    expected_amount = amount * (Decimal(probability) / 100)
                    
                    # Adjust probability based on historical data and stage
                    adjusted_probability = self._calculate_adjusted_probability(
                        stage_name, probability, account_id, amount
                    )
                    
                    # Identify risk factors
                    risk_factors = self._identify_risk_factors(
                        opp, stage_name, close_date, amount, account_id
                    )
                    
                    forecast = PaymentForecast(
                        opportunity_id=opp_id,
                        account_id=account_id,
                        account_name=account_name,
                        opportunity_name=opp_name,
                        stage_name=stage_name,
                        amount=amount,
                        probability=probability,
                        expected_amount=expected_amount,
                        close_date=close_date,
                        payment_terms=payment_terms,
                        expected_payment_date=expected_payment_date,
                        payment_probability=adjusted_probability,
                        risk_factors=risk_factors
                    )
                    
                    forecasts.append(forecast)
                    
                except Exception as e:
                    logger.warning(f"Error processing opportunity {opp.get('Id', 'unknown')}: {e}")
                    continue
            
            return forecasts
            
        except Exception as e:
            logger.error(f"Error generating payment forecasts: {e}")
            return []

    def _calculate_adjusted_probability(
        self, 
        stage: OpportunityStage, 
        stated_probability: int, 
        account_id: str, 
        amount: Decimal
    ) -> float:
        """Calculate adjusted probability based on historical data."""
        try:
            # Start with stated probability
            base_probability = stated_probability / 100.0
            
            # Apply stage-based adjustment
            stage_adjustment = self.stage_probabilities.get(stage, base_probability)
            
            # Weight between stated and stage-based probability
            adjusted_probability = (base_probability * 0.7) + (stage_adjustment * 0.3)
            
            # Apply historical win rate adjustment for this account (if available)
            account_win_rate = self._get_account_historical_win_rate(account_id)
            if account_win_rate is not None:
                adjusted_probability = (adjusted_probability * 0.8) + (account_win_rate * 0.2)
            
            # Apply deal size adjustment
            size_adjustment = self._get_deal_size_adjustment(amount)
            adjusted_probability *= size_adjustment
            
            # Ensure probability stays within bounds
            return max(0.0, min(1.0, adjusted_probability))
            
        except Exception as e:
            logger.warning(f"Error calculating adjusted probability: {e}")
            return stated_probability / 100.0

    def _get_account_historical_win_rate(self, account_id: str) -> Optional[float]:
        """Get historical win rate for an account."""
        try:
            closed_opps = self.historical_data_cache.get("closed_opportunities", [])
            account_opps = [opp for opp in closed_opps if opp.get("AccountId") == account_id]
            
            if len(account_opps) < 3:  # Need at least 3 data points
                return None
            
            won_count = sum(1 for opp in account_opps if opp.get("StageName") in WON_STAGES_SET)
            return won_count / len(account_opps)
            
        except Exception as e:
            logger.warning(f"Error calculating account win rate: {e}")
            return None

    def _get_deal_size_adjustment(self, amount: Decimal) -> float:
        """Get adjustment factor based on deal size."""
        try:
            closed_opps = self.historical_data_cache.get("closed_opportunities", [])
            if not closed_opps:
                return 1.0
            
            # Calculate average deal size
            amounts = [Decimal(str(opp.get("Amount", 0))) for opp in closed_opps if opp.get("Amount")]
            if not amounts:
                return 1.0
            
            avg_amount = sum(amounts) / len(amounts)
            
            # Larger deals tend to have lower close rates
            if amount > avg_amount * 2:
                return 0.85  # 15% reduction for very large deals
            elif amount > avg_amount * Decimal('1.5'):
                return 0.92  # 8% reduction for large deals
            elif amount < avg_amount * Decimal('0.5'):
                return 1.05  # 5% increase for small deals
            else:
                return 1.0  # No adjustment for average-sized deals
                
        except Exception as e:
            logger.warning(f"Error calculating deal size adjustment: {e}")
            return 1.0

    def _identify_risk_factors(
        self,
        opp: Dict[str, Any],
        stage: OpportunityStage,
        close_date: date,
        amount: Decimal,
        account_id: str
    ) -> List[str]:
        """Delegates to the pure `identify_risk_factors` function."""
        try:
            account_win_rate = self._get_account_historical_win_rate(account_id)
            return identify_risk_factors(opp, stage, close_date, amount, account_win_rate, date.today())
        except Exception as e:
            logger.warning(f"Error identifying risk factors: {e}")
            return []

    async def generate_cash_flow_projections(self, months_ahead: int = 6) -> List[CashFlowProjection]:
        """Generate cash flow projections by month."""
        await self._refresh_cache_if_needed()
        
        try:
            # Get payment forecasts
            payment_forecasts = await self.generate_payment_forecasts(days_ahead=months_ahead * 30)
            
            # Get current cash position (simplified - would come from Intacct in real implementation)
            current_cash = await self._get_current_cash_position()
            
            projections = []
            running_balance = current_cash
            
            for month_offset in range(months_ahead):
                period_start = date.today().replace(day=1) + timedelta(days=32 * month_offset)
                period_start = period_start.replace(day=1)  # First day of month
                
                # Calculate last day of month
                if period_start.month == 12:
                    period_end = period_start.replace(year=period_start.year + 1, month=1, day=1) - timedelta(days=1)
                else:
                    period_end = period_start.replace(month=period_start.month + 1, day=1) - timedelta(days=1)
                
                # Calculate projected receipts for this month
                month_receipts = Decimal('0')
                for forecast in payment_forecasts:
                    if period_start <= forecast.expected_payment_date <= period_end:
                        # Apply collection rate
                        collection_rate = self.collection_rates.get(forecast.payment_terms, 0.85)
                        expected_receipt = forecast.expected_amount * Decimal(str(collection_rate))
                        month_receipts += expected_receipt
                
                # Estimate monthly expenses (simplified - would come from historical data)
                monthly_expenses = await self._estimate_monthly_expenses()
                
                # Calculate net cash flow
                net_cash_flow = month_receipts - monthly_expenses
                closing_balance = running_balance + net_cash_flow
                
                # Calculate confidence level based on forecast reliability
                confidence_level = self._calculate_confidence_level(payment_forecasts, period_start, period_end)
                
                projection = CashFlowProjection(
                    period_start=period_start,
                    period_end=period_end,
                    opening_balance=running_balance,
                    projected_receipts=month_receipts,
                    projected_payments=monthly_expenses,
                    net_cash_flow=net_cash_flow,
                    closing_balance=closing_balance,
                    confidence_level=confidence_level
                )
                
                projections.append(projection)
                running_balance = closing_balance
            
            return projections
            
        except Exception as e:
            logger.error(f"Error generating cash flow projections: {e}")
            return []

    async def _get_current_cash_position(self) -> Decimal:
        """Get current cash position from Sage Intacct.

        Falls back to ForecastAssumptions.DEFAULT_CASH_POSITION when real data
        is unavailable.
        """
        try:
            intacct = self.mcp_client.sage_intacct
            result = await intacct.get_financial_metrics()
            if result.get("success") and result.get("data"):
                # TODO: calculate from actual GL cash accounts once Intacct returns real balances
                logger.info("Using default cash position assumption (Intacct integration pending)")
                return ForecastAssumptions.DEFAULT_CASH_POSITION
            return ForecastAssumptions.DEFAULT_CASH_POSITION
        except Exception as e:
            logger.warning(f"Error getting cash position, using assumption: {e}")
            return ForecastAssumptions.DEFAULT_CASH_POSITION

    async def _estimate_monthly_expenses(self) -> Decimal:
        """Estimate monthly expenses.

        Returns ForecastAssumptions.DEFAULT_MONTHLY_EXPENSES until historical
        expense analysis is implemented.
        """
        return ForecastAssumptions.DEFAULT_MONTHLY_EXPENSES

    def _calculate_confidence_level(
        self, 
        forecasts: List[PaymentForecast], 
        period_start: date, 
        period_end: date
    ) -> float:
        """Calculate confidence level for cash flow projection."""
        try:
            relevant_forecasts = [
                f for f in forecasts 
                if period_start <= f.expected_payment_date <= period_end
            ]
            
            if not relevant_forecasts:
                return 0.9  # High confidence if no forecasted receipts
            
            # Calculate weighted average probability
            total_amount = sum(f.expected_amount for f in relevant_forecasts)
            if total_amount == 0:
                return 0.9
            
            weighted_probability = sum(
                f.expected_amount * f.payment_probability for f in relevant_forecasts
            ) / total_amount
            
            # Adjust for number of forecasts (more forecasts = lower confidence due to complexity)
            forecast_count_adjustment = max(0.7, 1.0 - (len(relevant_forecasts) * 0.02))
            
            return min(0.95, weighted_probability * forecast_count_adjustment)
            
        except Exception as e:
            logger.warning(f"Error calculating confidence level: {e}")
            return 0.8

    async def calculate_forecasting_metrics(self) -> ForecastingMetrics:
        """Calculate key forecasting metrics."""
        await self._refresh_cache_if_needed()
        
        try:
            # Get current opportunities
            salesforce = self.mcp_client.salesforce
            
            closed_list = ", ".join(f"'{escape_soql_string(s)}'" for s in sorted(WON_STAGES_SET | LOST_STAGES_SET))
            pipeline_query = f"""
            SELECT Id, Amount, Probability, StageName, CloseDate, CreatedDate
            FROM Opportunity
            WHERE StageName NOT IN ({closed_list})
            """
            
            pipeline_result = await salesforce.query(pipeline_query)
            opportunities = pipeline_result.get("records", [])
            
            # Calculate pipeline metrics (delegating to pure functions)
            total_pipeline = sum(Decimal(str(opp.get("Amount", 0))) for opp in opportunities)
            weighted_pipeline = calculate_weighted_pipeline(opportunities)

            today = date.today()
            revenue_30 = calculate_expected_revenue_in_window(opportunities, today, 30)
            revenue_60 = calculate_expected_revenue_in_window(opportunities, today, 60)
            revenue_90 = calculate_expected_revenue_in_window(opportunities, today, 90)
            
            # Calculate historical metrics
            closed_opps = self.historical_data_cache.get("closed_opportunities", [])
            
            # Average deal size
            won_amounts = [
                Decimal(str(opp.get("Amount", 0)))
                for opp in closed_opps
                if opp.get("StageName") in WON_STAGES_SET and opp.get("Amount")
            ]
            avg_deal_size = sum(won_amounts) / len(won_amounts) if won_amounts else Decimal('0')

            # Win rate
            total_closed = len(closed_opps)
            won_count = sum(1 for opp in closed_opps if opp.get("StageName") in WON_STAGES_SET)
            win_rate = won_count / total_closed if total_closed > 0 else 0.0
            
            # Sales cycle (simplified calculation)
            avg_sales_cycle = self._calculate_average_sales_cycle(closed_opps)
            
            # Payment and collection metrics
            payment_metrics = await self._calculate_payment_metrics()
            
            # Risk metrics
            overdue_amount = await self._calculate_overdue_invoices()
            at_risk_amount = self._calculate_at_risk_opportunities(opportunities)
            concentration_risk = self._calculate_concentration_risk(opportunities)
            
            return ForecastingMetrics(
                total_pipeline_value=total_pipeline,
                weighted_pipeline_value=weighted_pipeline,
                expected_revenue_30_days=revenue_30,
                expected_revenue_60_days=revenue_60,
                expected_revenue_90_days=revenue_90,
                average_deal_size=avg_deal_size,
                average_sales_cycle_days=avg_sales_cycle,
                win_rate=win_rate,
                payment_collection_rate=payment_metrics["collection_rate"],
                average_payment_delay_days=payment_metrics["avg_delay"],
                cash_conversion_cycle_days=payment_metrics["conversion_cycle"],
                overdue_invoices_amount=overdue_amount,
                at_risk_opportunities_amount=at_risk_amount,
                concentration_risk_score=concentration_risk
            )
            
        except Exception as e:
            logger.error(f"Error calculating forecasting metrics: {e}")
            # Return default metrics on error
            return ForecastingMetrics(
                total_pipeline_value=Decimal('0'),
                weighted_pipeline_value=Decimal('0'),
                expected_revenue_30_days=Decimal('0'),
                expected_revenue_60_days=Decimal('0'),
                expected_revenue_90_days=Decimal('0'),
                average_deal_size=Decimal('0'),
                average_sales_cycle_days=0,
                win_rate=0.0,
                payment_collection_rate=0.0,
                average_payment_delay_days=0,
                cash_conversion_cycle_days=0,
                overdue_invoices_amount=Decimal('0'),
                at_risk_opportunities_amount=Decimal('0'),
                concentration_risk_score=0.0
            )

    def _calculate_average_sales_cycle(self, closed_opps: List[Dict[str, Any]]) -> int:
        """Calculate average sales cycle in days."""
        try:
            cycles = []
            for opp in closed_opps:
                if opp.get("CreatedDate") and opp.get("CloseDate"):
                    created = datetime.strptime(opp["CreatedDate"][:10], '%Y-%m-%d').date()
                    closed = datetime.strptime(opp["CloseDate"], '%Y-%m-%d').date()
                    cycle_days = (closed - created).days
                    if cycle_days > 0:  # Valid cycle
                        cycles.append(cycle_days)
            
            return int(statistics.mean(cycles)) if cycles else 60  # Default 60 days
            
        except Exception as e:
            logger.warning(f"Error calculating sales cycle: {e}")
            return 60

    async def _calculate_payment_metrics(self) -> Dict[str, Any]:
        """Calculate payment and collection metrics."""
        try:
            invoices = self.historical_data_cache.get("invoices", [])
            payments = self.historical_data_cache.get("payments", [])
            
            # Simplified calculation - in reality would match invoices to payments
            total_invoiced = sum(
                Decimal(str(inv.get("TOTALAMOUNT", 0))) 
                for inv in invoices
            )
            total_paid = sum(
                Decimal(str(pay.get("PAYMENTAMOUNT", 0))) 
                for pay in payments
            )
            
            collection_rate = float(total_paid / total_invoiced) if total_invoiced > 0 else ForecastAssumptions.DEFAULT_COLLECTION_RATE

            return {
                "collection_rate": collection_rate,
                "avg_delay": ForecastAssumptions.DEFAULT_AVG_PAYMENT_DELAY_DAYS,
                "conversion_cycle": ForecastAssumptions.DEFAULT_CASH_CONVERSION_CYCLE_DAYS,
            }

        except Exception as e:
            logger.warning(f"Error calculating payment metrics: {e}")
            return {
                "collection_rate": ForecastAssumptions.DEFAULT_COLLECTION_RATE,
                "avg_delay": ForecastAssumptions.DEFAULT_AVG_PAYMENT_DELAY_DAYS,
                "conversion_cycle": ForecastAssumptions.DEFAULT_CASH_CONVERSION_CYCLE_DAYS,
            }

    async def _calculate_overdue_invoices(self) -> Decimal:
        """Calculate total amount of overdue invoices."""
        try:
            intacct = self.mcp_client.sage_intacct
            
            # Get overdue invoices
            result = await intacct.get_invoices(limit=1000)
            
            if result.get("success") and result.get("data"):
                invoices = result["data"] if isinstance(result["data"], list) else [result["data"]]
                
                overdue_amount = Decimal('0')
                today = date.today()
                
                for invoice in invoices:
                    if invoice.get("WHENDUE") and invoice.get("STATE") != "Paid":
                        due_date = datetime.strptime(invoice["WHENDUE"][:10], '%Y-%m-%d').date()
                        if due_date < today:
                            overdue_amount += Decimal(str(invoice.get("TOTALDUE", 0)))
                
                return overdue_amount
            
            return Decimal('0')
            
        except Exception as e:
            logger.warning(f"Error calculating overdue invoices: {e}")
            return Decimal('0')

    def _calculate_at_risk_opportunities(self, opportunities: List[Dict[str, Any]]) -> Decimal:
        """Calculate total amount of at-risk opportunities."""
        try:
            at_risk_amount = Decimal('0')
            today = date.today()
            
            for opp in opportunities:
                # Consider opportunities at risk if:
                # 1. Close date is overdue
                # 2. Large amount with low probability
                # 3. Stuck in early stages with near-term close date
                
                close_date = datetime.strptime(opp["CloseDate"], '%Y-%m-%d').date() if opp.get("CloseDate") else None
                amount = Decimal(str(opp.get("Amount", 0)))
                probability = int(opp.get("Probability", 0))
                stage = opp.get("StageName", "")
                
                is_at_risk = False
                
                if close_date and close_date < today:
                    is_at_risk = True  # Overdue
                elif amount > Decimal('50000') and probability < 30:
                    is_at_risk = True  # Large deal with low probability
                elif (stage in ["Lead Gen", "New Lead", "Qualifying"] and
                      close_date and (close_date - today).days < 30):
                    is_at_risk = True  # Early stage with near-term close
                
                if is_at_risk:
                    at_risk_amount += amount
            
            return at_risk_amount
            
        except Exception as e:
            logger.warning(f"Error calculating at-risk opportunities: {e}")
            return Decimal('0')

    def _calculate_concentration_risk(self, opportunities: List[Dict[str, Any]]) -> float:
        """Calculate customer concentration risk score."""
        try:
            # Group opportunities by account
            account_totals = defaultdict(Decimal)
            total_pipeline = Decimal('0')
            
            for opp in opportunities:
                account_id = opp.get("AccountId", "unknown")
                amount = Decimal(str(opp.get("Amount", 0)))
                account_totals[account_id] += amount
                total_pipeline += amount
            
            if total_pipeline == 0:
                return 0.0
            
            # Calculate concentration - higher score means higher risk
            # Based on percentage of pipeline from top customer
            max_account_amount = max(account_totals.values()) if account_totals else Decimal('0')
            concentration_pct = float(max_account_amount / total_pipeline)
            
            # Risk score: 0.0 (low risk) to 1.0 (high risk)
            if concentration_pct > 0.5:
                return 1.0  # Very high risk
            elif concentration_pct > 0.3:
                return 0.7  # High risk
            elif concentration_pct > 0.2:
                return 0.4  # Medium risk
            else:
                return 0.1  # Low risk
                
        except Exception as e:
            logger.warning(f"Error calculating concentration risk: {e}")
            return 0.0

    async def generate_dashboard_data(
        self, 
        start_date: date, 
        end_date: date, 
        scenario: str = "realistic"
    ) -> ForecastingDashboardData:
        """Generate comprehensive dashboard data."""
        try:
            # Get all the components
            metrics = await self.calculate_forecasting_metrics()
            payment_forecasts = await self.generate_payment_forecasts(
                days_ahead=(end_date - start_date).days
            )
            cash_flow_projections = await self.generate_cash_flow_projections(
                months_ahead=6
            )
            
            # Prepare chart data
            cash_flow_chart_data = [
                {
                    "period": proj.period_start.strftime("%Y-%m"),
                    "receipts": float(proj.projected_receipts),
                    "payments": float(proj.projected_payments),
                    "net_flow": float(proj.net_cash_flow),
                    "balance": float(proj.closing_balance),
                    "confidence": proj.confidence_level
                }
                for proj in cash_flow_projections
            ]
            
            payment_forecast_data = [
                {
                    "opportunity_name": forecast.opportunity_name,
                    "account_name": forecast.account_name,
                    "amount": float(forecast.amount),
                    "expected_amount": float(forecast.expected_amount),
                    "payment_date": forecast.expected_payment_date.isoformat(),
                    "probability": forecast.payment_probability,
                    "stage": forecast.stage_name.value,
                    "risk_factors": forecast.risk_factors
                }
                for forecast in payment_forecasts[:20]  # Top 20 for dashboard
            ]
            
            # Pipeline summary
            pipeline_summary = {
                "total_opportunities": len(payment_forecasts),
                "total_value": float(metrics.total_pipeline_value),
                "weighted_value": float(metrics.weighted_pipeline_value),
                "avg_deal_size": float(metrics.average_deal_size),
                "win_rate": metrics.win_rate
            }
            
            # Risk indicators
            risk_indicators = [
                {
                    "type": "overdue_invoices",
                    "amount": float(metrics.overdue_invoices_amount),
                    "severity": "high" if metrics.overdue_invoices_amount > 10000 else "medium"
                },
                {
                    "type": "at_risk_opportunities",
                    "amount": float(metrics.at_risk_opportunities_amount),
                    "severity": "high" if metrics.at_risk_opportunities_amount > 50000 else "medium"
                },
                {
                    "type": "concentration_risk",
                    "score": metrics.concentration_risk_score,
                    "severity": "high" if metrics.concentration_risk_score > 0.7 else "medium"
                }
            ]
            
            # Recent activities (placeholder)
            recent_activities = [
                {
                    "type": "opportunity_updated",
                    "description": "Large deal moved to Negotiation stage",
                    "timestamp": datetime.now().isoformat(),
                    "impact": "positive"
                }
            ]
            
            return ForecastingDashboardData(
                current_metrics=metrics,
                pipeline_summary=pipeline_summary,
                cash_flow_chart_data=cash_flow_chart_data,
                payment_forecast_data=payment_forecast_data,
                risk_indicators=risk_indicators,
                recent_activities=recent_activities,
                date_range={"start": start_date, "end": end_date},
                selected_scenario=scenario,
                refresh_timestamp=datetime.now()
            )
            
        except Exception as e:
            logger.error(f"Error generating dashboard data: {e}")
            raise

    async def generate_comprehensive_report(
        self, 
        start_date: date, 
        end_date: date, 
        user_id: str
    ) -> ForecastingReport:
        """Generate comprehensive forecasting report."""
        try:
            report_id = str(uuid.uuid4())
            
            # Get all data components
            opportunities_data = await self._get_opportunities_for_report(start_date, end_date)
            invoices_data = await self._get_invoices_for_report(start_date, end_date)
            payments_data = await self._get_payments_for_report(start_date, end_date)
            
            payment_forecasts = await self.generate_payment_forecasts(
                days_ahead=(end_date - start_date).days
            )
            cash_flow_projections = await self.generate_cash_flow_projections()
            metrics = await self.calculate_forecasting_metrics()
            
            # Generate scenarios
            scenarios = [
                ForecastScenario(
                    scenario_name="Optimistic",
                    probability_multiplier=1.2,
                    payment_delay_factor=0.8,
                    collection_rate_adjustment=1.1,
                    description="Best case scenario with higher close rates and faster payments"
                ),
                ForecastScenario(
                    scenario_name="Realistic",
                    probability_multiplier=1.0,
                    payment_delay_factor=1.0,
                    collection_rate_adjustment=1.0,
                    description="Most likely scenario based on historical data"
                ),
                ForecastScenario(
                    scenario_name="Pessimistic",
                    probability_multiplier=0.8,
                    payment_delay_factor=1.3,
                    collection_rate_adjustment=0.9,
                    description="Conservative scenario with lower close rates and payment delays"
                )
            ]
            
            # Generate recommendations
            recommendations = self._generate_recommendations(metrics, payment_forecasts)
            risk_alerts = self._generate_risk_alerts(metrics, payment_forecasts)
            
            return ForecastingReport(
                report_id=report_id,
                generated_date=datetime.now(),
                report_period_start=start_date,
                report_period_end=end_date,
                opportunities=opportunities_data,
                invoices=invoices_data,
                payments=payments_data,
                payment_forecasts=payment_forecasts,
                cash_flow_projections=cash_flow_projections,
                metrics=metrics,
                scenarios=scenarios,
                recommendations=recommendations,
                risk_alerts=risk_alerts
            )
            
        except Exception as e:
            logger.error(f"Error generating comprehensive report: {e}")
            raise

    async def _get_opportunities_for_report(self, start_date: date, end_date: date) -> List[SalesforceOpportunity]:
        """Get opportunities for report."""
        # Implementation would fetch and parse opportunities
        return []

    async def _get_invoices_for_report(self, start_date: date, end_date: date) -> List[IntacctInvoice]:
        """Get invoices for report."""
        # Implementation would fetch and parse invoices
        return []

    async def _get_payments_for_report(self, start_date: date, end_date: date) -> List[IntacctPayment]:
        """Get payments for report."""
        # Implementation would fetch and parse payments
        return []

    def _generate_recommendations(
        self, 
        metrics: ForecastingMetrics, 
        forecasts: List[PaymentForecast]
    ) -> List[str]:
        """Generate actionable recommendations."""
        recommendations = []
        
        # Cash flow recommendations
        if metrics.expected_revenue_30_days < metrics.average_deal_size * 2:
            recommendations.append("Focus on closing near-term opportunities to improve 30-day cash flow")
        
        # Collection recommendations
        if metrics.payment_collection_rate < 0.85:
            recommendations.append("Review payment terms and collection processes to improve cash collection")
        
        # Pipeline recommendations
        if metrics.win_rate < 0.25:
            recommendations.append("Analyze lost opportunities to identify areas for sales process improvement")
        
        # Risk recommendations
        if metrics.concentration_risk_score > 0.5:
            recommendations.append("Diversify customer base to reduce concentration risk")
        
        return recommendations

    def _generate_risk_alerts(
        self, 
        metrics: ForecastingMetrics, 
        forecasts: List[PaymentForecast]
    ) -> List[str]:
        """Generate risk alerts."""
        alerts = []
        
        if metrics.overdue_invoices_amount > 25000:
            alerts.append(f"High overdue invoices: ${metrics.overdue_invoices_amount:,.2f}")
        
        if metrics.at_risk_opportunities_amount > 100000:
            alerts.append(f"At-risk opportunities: ${metrics.at_risk_opportunities_amount:,.2f}")
        
        if metrics.concentration_risk_score > 0.7:
            alerts.append("High customer concentration risk detected")
        
        return alerts

