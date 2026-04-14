import React, { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { CssBaseline, Box, CircularProgress } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { QueryClient, QueryClientProvider } from 'react-query';
import { Toaster } from 'react-hot-toast';

import { AuthProvider } from './contexts/AuthContext';
import { PermissionsProvider } from './contexts/PermissionsContext';
import { LeadsProvider } from './contexts/LeadsContext';
import ProtectedRoute from './components/ProtectedRoute';
import PermissionGate from './components/PermissionGate';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Pipeline from './pages/Pipeline';
import Settings from './pages/Settings';
import SalesforceCallback from './pages/SalesforceCallback';
import MyDashboard from './pages/MyDashboard';
import Pebble from './pages/Pebble';

// Lazy load non-MVP routes to reduce initial bundle
const Revenue = lazy(() => import('./pages/Revenue'));
const AutomationReview = lazy(() => import('./pages/AutomationReview'));
const Research = lazy(() => import('./pages/Research'));
const DataTools = lazy(() => import('./pages/DataTools'));
const Projects = lazy(() => import('./pages/Projects'));
const NewOpportunity = lazy(() => import('./pages/NewOpportunity'));
const PaymentSchedule = lazy(() => import('./pages/PaymentSchedule'));

const LazyFallback = () => (
  <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 200 }}>
    <CircularProgress />
  </Box>
);

// Create Material-UI theme
const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1976d2',
      light: '#42a5f5',
      dark: '#1565c0',
    },
    secondary: {
      main: '#dc004e',
      light: '#ff5983',
      dark: '#9a0036',
    },
    background: {
      default: '#f5f5f5',
      paper: '#ffffff',
    },
  },
  typography: {
    fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
    h4: {
      fontWeight: 600,
    },
    h5: {
      fontWeight: 600,
    },
    h6: {
      fontWeight: 600,
    },
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          borderRadius: 8,
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          borderRadius: 6,
        },
      },
    },
  },
});

// Create React Query client with aggressive caching
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnMount: false,       // Don't refetch when component remounts if data is fresh
      staleTime: 5 * 60 * 1000,   // Data is "fresh" for 5 minutes (won't refetch)
      cacheTime: 30 * 60 * 1000,  // Keep unused data in memory for 30 min
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <ErrorBoundary>
        <AuthProvider>
          <PermissionsProvider>
          <LeadsProvider>
          <LocalizationProvider dateAdapter={AdapterDateFns}>
          <Router>
            <Routes>
              {/* Public routes */}
              <Route path="/login" element={<Login />} />
              <Route path="/callback" element={<SalesforceCallback />} />
              
              {/* Protected routes */}
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Navigate to="/dashboard" replace />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/priorities"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <MyDashboard />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Overview />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              {/* Backward compat: /overview → /dashboard */}
              <Route
                path="/overview"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Navigate to="/dashboard" replace />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/reports"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Pipeline />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              {/* Back-compat: old /pipeline links still resolve. Safe to drop
                  after one release cycle once no bookmarks / shared URLs point here. */}
              <Route path="/pipeline" element={<Navigate to="/reports" replace />} />
              <Route
                path="/automation-review"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Suspense fallback={<LazyFallback />}>
                        <AutomationReview />
                      </Suspense>
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/research"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Suspense fallback={<LazyFallback />}>
                        <Research />
                      </Suspense>
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/cashflow"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Suspense fallback={<LazyFallback />}>
                        <Revenue />
                      </Suspense>
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/data-tools"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Suspense fallback={<LazyFallback />}>
                        <DataTools />
                      </Suspense>
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/projects"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <PermissionGate permission="view_projects">
                        <Suspense fallback={<LazyFallback />}>
                          <Projects />
                        </Suspense>
                      </PermissionGate>
                    </Layout>
                  </ProtectedRoute>
                }
              />
              {/* Legacy routes — redirect to new paths */}
              <Route
                path="/cleanup"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Navigate to="/data-tools" replace />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/pebble"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <PermissionGate permission={(can) => can('use_pebble_chat') || can('use_pebble_research')}>
                        <Pebble />
                      </PermissionGate>
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route path="/prospect-import" element={<Navigate to="/pebble" replace />} />
              <Route
                path="/revenue"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Navigate to="/cashflow" replace />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/giving-capacity"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Navigate to="/research" replace />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/network"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Navigate to="/research" replace />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/opportunities/new"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Suspense fallback={<LazyFallback />}>
                        <NewOpportunity />
                      </Suspense>
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/payment-schedule/:opportunityId"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Suspense fallback={<LazyFallback />}>
                        <PaymentSchedule />
                      </Suspense>
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/settings"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Settings />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/weekly-priorities"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Navigate to="/priorities" replace />
                    </Layout>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </Router>
          </LocalizationProvider>
          </LeadsProvider>
          </PermissionsProvider>
          <Toaster
            position="top-right"
            toastOptions={{
              duration: 4000,
              style: {
                background: '#363636',
                color: '#fff',
              },
              success: {
                duration: 3000,
                iconTheme: {
                  primary: '#4caf50',
                  secondary: '#fff',
                },
              },
              error: {
                duration: 5000,
                iconTheme: {
                  primary: '#f44336',
                  secondary: '#fff',
                },
              },
            }}
          />
        </AuthProvider>
        </ErrorBoundary>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;

