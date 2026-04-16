# Grant Lifecycle System - Revised Implementation Plan

**Status:** Ready to Build (with critical fixes)
**Last Updated:** November 13, 2025

---

## 🎯 **Implementation Strategy: Start Simple, Add Complexity**

We're building in **3 phases** to reduce risk and validate assumptions:

---

## 📦 **PHASE 1: MVP - Manual & Safe** (Build First)

**Goal:** Basic workflow that mirrors current manual process but reduces errors

### **What We're Building:**

#### **1.1 Payment Schedule Management** ✅
- **Finance-initiated** (not automatic at close)
- Manual entry of payment dates and amounts
- Validation: total must equal opportunity amount
- Can edit before invoice creation
- **NO automatic prompt** when opportunity closes

**Key Decision:** Make payment schedule creation optional and finance-controlled

#### **1.2 Finance Dashboard** ✅
- **Tab 1: Closed Won - Ready to Invoice**
  - Shows opportunities in "Closed Won" stage
  - Filter: Has/doesn't have payment schedule
  - Button: "Create Payment Schedule"
  - Button: "Create Invoice" (only if schedule exists)
  
- **Tab 2: Active Collections**
  - Shows opportunities in "Collecting / In Effect" stage
  - Display: Invoice count, payment count, received count
  - Button: "Track Payments"
  
- **Tab 3: Completed**
  - Shows opportunities in "Closed / Completed" stage
  - Display: Summary of invoices and payments

#### **1.3 Sage Invoice Creation** ✅
- **One invoice per grant** (MVP limitation)
- Creates invoice in Sage Intacct
- Creates Sage_Invoice__c record in Salesforce
- Links invoice to opportunity
- **Duplicate prevention:** Check if invoice already exists
- **State change:** Moves opportunity to "Collecting / In Effect"

**Critical Addition:** Invoice__c lookup field on npe01__OppPayment__c

#### **1.4 Payment Tracking** ✅
- View scheduled payments for a grant
- Mark individual payments as "Received"
- Record actual payment date
- **Manual completion:** Button to mark opportunity complete
- **NO auto-completion** in MVP

#### **1.5 Grant Agreement Upload** ✅
- **Optional** upload when closing grant
- Can be added/updated later
- Multiple document support (using Salesforce Files)
- Accessible from Finance Dashboard

---

### **Phase 1 Data Model:**

```
Opportunity
├─ StageName (picklist)
│  ├─ Prospecting
│  ├─ Proposal Submitted
│  ├─ Closed Won ← Finance creates payment schedule here
│  ├─ Collecting / In Effect ← After invoice created
│  └─ Closed / Completed ← Manual completion
│
├─ Amount (currency)
├─ CloseDate (date)
└─ ContentDocumentLinks ← Grant agreements

npe01__OppPayment__c (NPSP Payment)
├─ npe01__Opportunity__c (lookup)
├─ npe01__Payment_Amount__c
├─ npe01__Scheduled_Date__c
├─ npe01__Payment_Date__c
├─ npe01__Paid__c (boolean)
└─ Invoice__c (NEW: lookup to Sage_Invoice__c) ⚠️ MUST ADD

Sage_Invoice__c (Custom Object)
├─ Opportunity__c (Master-Detail)
├─ Sage_Invoice_ID__c (text - external ID)
├─ Invoice_Amount__c (currency)
├─ Invoice_Date__c (date)
├─ Due_Date__c (date)
├─ Invoice_Status__c (picklist: Draft, Sent, Partial, Paid, Overdue)
├─ Description__c (long text)
└─ Created_in_Sage_Date__c (datetime)
```

---

### **Phase 1 Workflows:**

#### **Workflow A: Creating First Invoice for New Grant**

```
1. Grant closes → Opportunity marked "Closed Won"
2. [MANUAL] Finance reviews grant agreement
3. Finance clicks "Create Payment Schedule"
   ├─ Enters payment amounts and dates
   ├─ System validates: total = opportunity amount
   └─ Saves to npe01__OppPayment__c
4. Finance clicks "Create Invoice"
   ├─ System checks: Does Sage_Invoice__c already exist? ⚠️ DUPLICATE CHECK
   ├─ If yes: Show error "Invoice already created"
   ├─ If no: Proceed
   ├─ Creates invoice in Sage Intacct via API
   ├─ Creates Sage_Invoice__c record
   ├─ Links payments to invoice (Invoice__c field) ⚠️ NEW
   └─ Updates Opportunity.StageName = "Collecting / In Effect"
5. Invoice sent to funder (manual or automatic in Sage)
```

#### **Workflow B: Tracking Payment Receipt**

```
1. Payment arrives in bank account
2. Finance reconciles and identifies grant
3. Finance opens "Active Collections" dashboard
4. Clicks "Track Payments" for the grant
5. Marks payment as "Received"
   ├─ Sets npe01__Paid__c = true
   ├─ Sets npe01__Payment_Date__c = today
   └─ Saves
6. [MANUAL] When all payments received:
   ├─ Finance clicks "Mark Complete"
   └─ Updates Opportunity.StageName = "Closed / Completed"
```

---

### **Phase 1 Validations:**

**Payment Schedule:**
- ✅ Total of all payments = Opportunity.Amount
- ✅ All dates in future (or warning if in past)
- ✅ All amounts > 0
- ✅ At least one payment required

**Invoice Creation:**
- ✅ Payment schedule must exist
- ✅ No existing Sage_Invoice__c for this opportunity
- ✅ Opportunity in "Closed Won" stage
- ✅ Customer exists in Sage (or show error)

**Payment Tracking:**
- ✅ Can only mark "Paid" if in "Collecting / In Effect" stage
- ✅ Payment date can't be in future
- ✅ Can't "unpay" without permission

**Completion:**
- ✅ All payments must be marked paid
- ✅ Must have at least one invoice
- ⚠️ Optional: Require confirmation dialog

---

### **Phase 1 Limitations (By Design):**

These are intentional simplifications for MVP:

1. **One invoice per grant only**
   - Multi-invoice support in Phase 2
   
2. **Manual payment tracking**
   - No Sage payment sync in MVP
   
3. **Manual completion**
   - No auto-completion even if all paid
   
4. **No amendment workflow**
   - Handle amendments manually, add workflow in Phase 2
   
5. **Basic error handling**
   - Show error message, no rollback
   - Add proper transaction handling in Phase 2
   
6. **No invoice editing/voiding**
   - Must be done in Sage, manually update Salesforce
   
7. **No concurrency locking**
   - Just duplicate detection
   - Add proper locking in Phase 2

---

## 📦 **PHASE 2: Automation & Multi-Invoice** (Build After Validation)

**Goal:** Support complex scenarios after validating basic workflow

### **What We're Adding:**

#### **2.1 Multi-Invoice Support**
- Create multiple invoices per grant
- Link specific payments to specific invoices
- Track "Invoice 1 of 3" status

#### **2.2 Smart Completion**
- System suggests completion when conditions met:
  - ✅ All payments marked received
  - ✅ All invoices paid
  - ✅ 30 days past final payment date
- Requires finance approval to complete

#### **2.3 Amendment Workflow**
- "Create Amendment" button
- Tracks amendment history
- Creates new invoice for additional funding
- Links amended records

#### **2.4 Enhanced Validations**
- Lock payment schedule after invoice created
- Prevent opportunity amount changes if payments exist
- Validate payment-invoice amount matching

#### **2.5 Payment Variance Handling**
- Record expected vs. actual amount
- Track payment variance reasons
- Show variance alerts

---

## 📦 **PHASE 3: Advanced Features** (Build After Phase 2 Stable)

**Goal:** Full-featured system with all bells and whistles

### **What We're Adding:**

#### **3.1 Sage Payment Sync**
- Nightly job to check Sage for received payments
- Auto-update Salesforce payments when Sage shows paid
- Reconciliation report

#### **3.2 Advanced Reporting**
- Overdue invoice alerts
- Revenue forecasting
- Payment aging report
- Grant portfolio dashboard
- Custom report builder

#### **3.3 Workflow Automation**
- Auto-send invoice reminders
- Escalation for overdue payments
- Email notifications
- Slack integrations

#### **3.4 Error Recovery**
- Transaction rollback on failure
- Retry logic for API calls
- Error logging and monitoring
- Audit trail

#### **3.5 Concurrency Control**
- Record locking during operations
- "In progress" indicators
- Prevent duplicate operations

---

## 🔧 **CRITICAL FIXES TO IMPLEMENT NOW**

Before building anything, these MUST be done:

### **Fix #1: Add Invoice__c Field to Payments**

**Object:** npe01__OppPayment__c
**New Field:** Invoice__c (Lookup to Sage_Invoice__c)
**Why:** Links payments to specific invoices for multi-invoice scenarios

```
Field Details:
- API Name: Invoice__c
- Type: Lookup (Sage_Invoice__c)
- Label: "Sage Invoice"
- Required: No (for backwards compatibility)
- Help Text: "The Sage Intacct invoice this payment is associated with"
```

---

### **Fix #2: Update Sage_Invoice__c Object**

**Add Fields:**
```
1. Invoice_Status__c (Picklist) - REQUIRED
   Values: Draft, Sent, Partial, Paid, Overdue, Void
   
2. Amount_Received__c (Currency, Rollup) - Auto calculated
   Rollup: SUM of related payments where Paid = true
   
3. Amount_Outstanding__c (Formula) - Auto calculated
   Formula: Invoice_Amount__c - Amount_Received__c
   
4. Overdue__c (Formula, Checkbox) - Auto calculated
   Formula: AND(
     Due_Date__c < TODAY(),
     Invoice_Status__c != "Paid",
     Invoice_Status__c != "Void"
   )
```

---

### **Fix #3: Add Duplicate Detection**

**Validation Rule on Sage_Invoice__c:**
```
Before Insert:
- Check if Sage_Invoice__c already exists with same Opportunity__c
- If yes: Throw error "Invoice already exists for this opportunity"
- If no: Allow creation

In Code:
- Query for existing invoice before creating
- Show user-friendly error
```

---

### **Fix #4: Update Opportunity Stage Picklist**

**Ensure these values exist:**
```
Opportunity.StageName:
- Prospecting
- Qualification
- Proposal Submitted
- Negotiation
- Closed Won ← Finance starts here
- Collecting / In Effect ← After invoice created
- Closed / Completed ← After all payments received
- Closed Lost
```

---

### **Fix #5: Create Permission Sets**

**Three permission sets:**

**A. Grant Writer**
- Read: Opportunities, Accounts, Contacts
- Create/Edit: Opportunities (limited fields)
- Read-only: Sage_Invoice__c, npe01__OppPayment__c
- Upload: Grant agreement documents

**B. Finance User**
- Full access: Sage_Invoice__c, npe01__OppPayment__c
- Edit: Opportunity (StageName, Amount)
- Create: Invoices in Sage
- Delete: Payments (with confirmation)

**C. Finance Admin**
- All Finance User permissions
- Plus: Delete invoices, void invoices, edit locked records
- System configuration access

---

## 🚀 **BUILD ORDER**

**Step 1: Salesforce Setup** (Do First)
```
1. Create Sage_Invoice__c object (via OAuth script)
2. Add Invoice__c field to npe01__OppPayment__c
3. Create permission sets
4. Update Opportunity stages
5. Test with dummy data
```

**Step 2: Backend API** (Do Second)
```
1. Payment schedule endpoints (GET, POST, PUT, DELETE)
2. Finance dashboard endpoints (3 tabs)
3. Invoice creation endpoint (with duplicate check)
4. Payment tracking endpoint
5. Error handling for all endpoints
```

**Step 3: Frontend UI** (Do Third)
```
1. Payment Schedule Modal
2. Finance Dashboard (3 tabs)
3. Payment Tracking Modal
4. Grant Agreement Upload
5. Confirmation dialogs
```

**Step 4: Testing** (Do Fourth)
```
1. Unit tests for backend
2. Integration tests with Sage sandbox
3. Manual testing with 3-5 real grants
4. User acceptance testing with finance team
5. Fix issues found
```

**Step 5: Deployment** (Do Fifth)
```
1. Deploy Salesforce changes
2. Deploy backend updates
3. Deploy frontend updates
4. Train finance team
5. Monitor for issues
```

---

## ✅ **SUCCESS CRITERIA**

**Phase 1 is successful if:**

1. ✅ Finance can create payment schedules accurately
2. ✅ Invoices are created in Sage without duplicates
3. ✅ Payments are tracked and matched correctly
4. ✅ No data corruption or lost invoices
5. ✅ Finance team says it's faster than old process
6. ✅ Zero critical bugs in first 30 days

**Metrics to track:**
- Time to create invoice (before vs. after)
- Number of invoice errors/duplicates
- Payment matching accuracy
- User satisfaction score
- Support tickets related to invoicing

---

## ⚠️ **RISKS & MITIGATION**

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Sage API fails | Medium | High | Proper error messages, manual fallback |
| Duplicate invoices | Medium | High | Validation rules, UI warnings |
| User confusion | High | Medium | Training, documentation, tooltips |
| Payment mismatch | Medium | High | Clear UI, confirmation dialogs |
| Data corruption | Low | Critical | Validation, testing, backups |
| Sage assumptions wrong | High | High | **Validate with test invoice FIRST** |

---

## 📋 **PRE-BUILD CHECKLIST**

Before writing any code:

- [ ] Finance team completes discovery questionnaire
- [ ] Review responses with finance team
- [ ] Test creating invoice in Sage manually
- [ ] Verify Sage API credentials work
- [ ] Create 3-5 test grants in Salesforce
- [ ] Gather sample grant agreements
- [ ] Get sample invoice templates
- [ ] Define exactly who will use system
- [ ] Get sign-off on Phase 1 limitations
- [ ] Agree on success metrics

---

## 🎯 **NEXT IMMEDIATE STEPS**

1. ✅ **Send questionnaire** to finance team
2. **Wait for responses** (don't build blindly!)
3. **Schedule review meeting** to discuss responses
4. **Test Sage integration** manually
5. **Then start building** Phase 1 with fixes

---

## 📞 **QUESTIONS TO ASK IN REVIEW MEETING**

**Key validation questions:**

1. "Walk me through your last grant invoice creation. Every step."
2. "Show me the grant agreement. Where are payment terms?"
3. "How do you know when to invoice?"
4. "What happens when this goes wrong today?"
5. "If the system does X, will that actually help or create more work?"

---

**Ready to build once questionnaire is completed and reviewed!** 🚀

