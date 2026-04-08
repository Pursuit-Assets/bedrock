import React, { useMemo, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Grid,
  Typography,
  IconButton,
  Tooltip,
} from '@mui/material';
import {
  AttachMoney as MoneyIcon,
  BarChart as WeightedIcon,
  Event as EventIcon,
  EditOutlined as EditIcon,
} from '@mui/icons-material';
import { parseISO, startOfDay, endOfDay } from 'date-fns';
import { formatDollarMillions } from '../utils/formatters';
import { OPEN_STAGES } from '../types/salesforce';
import { usePermissions } from '../contexts/PermissionsContext';
import GoalTracker from './GoalTracker';
import EditOwnerGoalDialog from './EditOwnerGoalDialog';

interface OwnerGoalWidgetProps {
  sfUserId: string;
  ownerName: string;
  goalAmount: number;
  /** True if goalAmount came from a backend row, false if it's the DEFAULT_GOAL fallback */
  hasBackendGoal: boolean;
  fiscalYear: number;
  allOpportunities: any[];
}

const OwnerGoalWidget: React.FC<OwnerGoalWidgetProps> = ({
  sfUserId,
  ownerName,
  goalAmount,
  hasBackendGoal,
  fiscalYear,
  allOpportunities,
}) => {
  const { can } = usePermissions();
  const canEditGoal = can('manage_owner_goals');
  const [editOpen, setEditOpen] = useState(false);

  const ownerOpps = useMemo(
    () => allOpportunities.filter((o: any) => o.OwnerId === sfUserId),
    [allOpportunities, sfUserId],
  );

  const openOpps = useMemo(
    () => ownerOpps.filter((o: any) => OPEN_STAGES.includes(o.StageName)),
    [ownerOpps],
  );

  const stats = useMemo(() => {
    const count = openOpps.length;
    const total = openOpps.reduce((sum: number, o: any) => sum + (o.Amount || 0), 0);
    const weighted = openOpps.reduce(
      (sum: number, o: any) => sum + ((o.Amount || 0) * (o.Probability || 0)) / 100,
      0,
    );

    const now = new Date();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const closingThisMonth = openOpps.filter((o: any) => {
      if (!o.CloseDate) return false;
      const d = parseISO(o.CloseDate);
      return d >= startOfDay(now) && d <= endOfDay(monthEnd);
    });
    const closingAmount = closingThisMonth.reduce(
      (s: number, o: any) => s + ((o.Amount || 0) * (o.Probability || 0)) / 100,
      0,
    );

    return { count, total, weighted, closingThisMonth: closingThisMonth.length, closingAmount };
  }, [openOpps]);

  return (
    <>
      <Card sx={{ mb: 2 }}>
        <CardContent sx={{ pb: 2 }}>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} md={5}>
              <Box sx={{ position: 'relative' }}>
                {canEditGoal && (
                  <Tooltip title="Edit goal" arrow>
                    <IconButton
                      size="small"
                      onClick={() => setEditOpen(true)}
                      sx={{
                        position: 'absolute',
                        top: 0,
                        right: 0,
                        zIndex: 1,
                      }}
                    >
                      <EditIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                )}
                <GoalTracker
                  goalAmount={goalAmount}
                  allOpportunities={allOpportunities}
                  filterUserId={sfUserId}
                  ownerName={ownerName}
                />
              </Box>
            </Grid>
            <Grid item xs={12} md={7}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={4}>
                  <Card variant="outlined">
                    <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                      <MoneyIcon color="primary" sx={{ fontSize: 20 }} />
                      <Typography variant="caption" color="text.secondary" display="block">
                        Total Pipeline
                      </Typography>
                      <Typography variant="h5" sx={{ fontWeight: 700 }}>
                        {formatDollarMillions(stats.total)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {stats.count} open opportunities
                      </Typography>
                    </CardContent>
                  </Card>
                </Grid>
                <Grid item xs={12} sm={4}>
                  <Card variant="outlined">
                    <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                      <WeightedIcon color="primary" sx={{ fontSize: 20 }} />
                      <Typography variant="caption" color="text.secondary" display="block">
                        Weighted Pipeline
                      </Typography>
                      <Typography variant="h5" sx={{ fontWeight: 700 }}>
                        {formatDollarMillions(stats.weighted)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Probability-weighted
                      </Typography>
                    </CardContent>
                  </Card>
                </Grid>
                <Grid item xs={12} sm={4}>
                  <Card variant="outlined">
                    <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                      <EventIcon color="primary" sx={{ fontSize: 20 }} />
                      <Typography variant="caption" color="text.secondary" display="block">
                        Closing This Mo.
                      </Typography>
                      <Typography variant="h5" sx={{ fontWeight: 700 }}>
                        {formatDollarMillions(stats.closingAmount)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {stats.closingThisMonth} deal{stats.closingThisMonth !== 1 ? 's' : ''}
                      </Typography>
                    </CardContent>
                  </Card>
                </Grid>
              </Grid>
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {canEditGoal && (
        <EditOwnerGoalDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          sfUserId={sfUserId}
          ownerName={ownerName}
          fiscalYear={fiscalYear}
          currentAmount={goalAmount}
          hasBackendGoal={hasBackendGoal}
        />
      )}
    </>
  );
};

export default OwnerGoalWidget;
