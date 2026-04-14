import React, { useState, useEffect } from 'react';
import {
  Box,
  Tabs,
  Tab,
  Typography,
} from '@mui/material';
import {
  MonetizationOn as MonetizationOnIcon,
  Business as BusinessIcon,
  Person as PersonIcon,
  PersonSearch as PersonSearchIcon,
  Assignment as AssignmentIcon,
} from '@mui/icons-material';

import Opportunities from './Opportunities';
import Accounts from './Accounts';
import Contacts from './Contacts';
import Leads from './Leads';
import Tasks from './Tasks';
import { useSearchParams } from 'react-router-dom';
import ConnectPrompt from '../components/ConnectPrompt';
import { useAuth } from '../contexts/AuthContext';
import { DialogStackProvider, DialogStackRenderer } from '../contexts/DialogStackContext';

const TAB_MAP: Record<string, number> = {
  opportunities: 0,
  accounts: 1,
  contacts: 2,
  leads: 3,
  tasks: 4,
};

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`reports-tabpanel-${index}`}
      aria-labelledby={`reports-tab-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ pt: 1 }}>{children}</Box>}
    </div>
  );
}

export default function Reports() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') || '';
  const [currentTab, setCurrentTab] = useState(TAB_MAP[tabParam] ?? 0);

  // Sync tab when URL param changes (e.g., "View in Reports" from global search)
  useEffect(() => {
    if (tabParam && TAB_MAP[tabParam] !== undefined) {
      setCurrentTab(TAB_MAP[tabParam]);
    }
  }, [tabParam]);

  const handleTabChange = (event: React.SyntheticEvent, newValue: number) => {
    setCurrentTab(newValue);
  };

  if (!user?.salesforce_connected) {
    return (
      <Box>
        <ConnectPrompt service="Salesforce" message="Connect Salesforce to view pipeline data." />
      </Box>
    );
  }

  return (
    <DialogStackProvider>
      <Box>
        <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 1 }}>
          <Tabs
            value={currentTab}
            onChange={handleTabChange}
            aria-label="reports tabs"
            sx={{ minHeight: 48 }}
          >
            <Tab
              icon={<MonetizationOnIcon />}
              iconPosition="start"
              label="Opportunities"
              id="reports-tab-0"
              aria-controls="reports-tabpanel-0"
            />
            <Tab
              icon={<BusinessIcon />}
              iconPosition="start"
              label="Accounts"
              id="reports-tab-1"
              aria-controls="reports-tabpanel-1"
            />
            <Tab
              icon={<PersonIcon />}
              iconPosition="start"
              label="Contacts"
              id="reports-tab-2"
              aria-controls="reports-tabpanel-2"
            />
            <Tab
              icon={<PersonSearchIcon />}
              iconPosition="start"
              label="Leads"
              id="reports-tab-3"
              aria-controls="reports-tabpanel-3"
            />
            <Tab
              icon={<AssignmentIcon />}
              iconPosition="start"
              label="Tasks"
              id="reports-tab-4"
              aria-controls="reports-tabpanel-4"
            />
          </Tabs>
        </Box>

        <TabPanel value={currentTab} index={0}>
          <Opportunities />
        </TabPanel>

        <TabPanel value={currentTab} index={1}>
          <Accounts />
        </TabPanel>

        <TabPanel value={currentTab} index={2}>
          <Contacts />
        </TabPanel>

        <TabPanel value={currentTab} index={3}>
          <Leads />
        </TabPanel>

        <TabPanel value={currentTab} index={4}>
          <Tasks />
        </TabPanel>
      </Box>
      <DialogStackRenderer />
    </DialogStackProvider>
  );
}

