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
      id={`details-tabpanel-${index}`}
      aria-labelledby={`details-tab-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ pt: 1 }}>{children}</Box>}
    </div>
  );
}

export default function Details() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') || '';
  const [currentTab, setCurrentTab] = useState(TAB_MAP[tabParam] ?? 0);

  // Sync tab when URL param changes (e.g., "View in Details" from global search)
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
            aria-label="details tabs"
            sx={{ minHeight: 48 }}
          >
            <Tab
              icon={<MonetizationOnIcon />}
              iconPosition="start"
              label="Opportunities"
              id="details-tab-0"
              aria-controls="details-tabpanel-0"
            />
            <Tab
              icon={<BusinessIcon />}
              iconPosition="start"
              label="Accounts"
              id="details-tab-1"
              aria-controls="details-tabpanel-1"
            />
            <Tab
              icon={<PersonIcon />}
              iconPosition="start"
              label="Contacts"
              id="details-tab-2"
              aria-controls="details-tabpanel-2"
            />
            <Tab
              icon={<PersonSearchIcon />}
              iconPosition="start"
              label="Leads"
              id="details-tab-3"
              aria-controls="details-tabpanel-3"
            />
            <Tab
              icon={<AssignmentIcon />}
              iconPosition="start"
              label="Tasks"
              id="details-tab-4"
              aria-controls="details-tabpanel-4"
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

