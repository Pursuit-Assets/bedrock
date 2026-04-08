import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { apiService } from '../services/api';

interface User {
  email: string;
  name: string;
  picture?: string;
  sub: string;
  salesforce_connected?: boolean;
  salesforce_user_id?: string | null;
  salesforce_user_name?: string | null;
  google_connected?: boolean;
  google_email?: string;
  slack_configured?: boolean;
  slack_workspace?: string | null;
  calendar_pbd_id?: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
  connectSalesforce: () => void;
  disconnectSalesforce: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUser = async () => {
    try {
      const response = await apiService.getCurrentUser();
      setUser(response.data);
    } catch (error) {
      // No dev bypass — always require real Google OAuth.
      // Removed REACT_APP_DEV_BYPASS branch (was lines 51-64 historically) to
      // eliminate the attack surface entirely. See DEV_SETUP_GUIDE for local
      // dev setup with real Google OAuth.
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUser();
  }, []);

  const logout = async () => {
    try {
      await apiService.logout();
      setUser(null);
      window.location.href = '/login';
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const refetch = async () => {
    setLoading(true);
    await fetchUser();
  };

  const connectSalesforce = () => {
    // Redirect to backend Salesforce OAuth endpoint
    const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8000';
    window.location.href = `${apiUrl}/auth/salesforce`;
  };

  const disconnectSalesforce = async () => {
    try {
      await apiService.disconnectSalesforce();
      // Refresh user data to update SF connection status
      await fetchUser();
    } catch (error) {
      console.error('Disconnect error:', error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, logout, refetch, connectSalesforce, disconnectSalesforce }}>
      {children}
    </AuthContext.Provider>
  );
};
