/**
 * AllowlistsPage - Manage Allowlists
 * 
 * Dedicated page for creating and managing allowlists.
 * These control who can see your private/allowlist-scoped answers.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import Header from '../components/Header';
import AllowlistManager from '../components/AllowlistManager';
import { useAuth } from '../context/AuthContext';
import './AllowlistsPage.css';

const AllowlistsPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return (
      <div className="allowlists-page">
        <Header title="Allowlists" />
        <div className="allowlists-container allowlists-unauthenticated">
          <div className="allowlists-empty-icon">
            <Users size={48} />
          </div>
          <h2>Sign in to manage your allowlists</h2>
          <p>Control who can see your private answers by creating custom allowlists.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="allowlists-page">
      <Header title="Allowlists" />
      
      <div className="allowlists-container">
        {/* Header */}
        <div className="allowlists-header">
          <div className="allowlists-title-row">
            <div className="allowlists-icon">
              <Users size={24} />
            </div>
            <div>
              <h1>Allowlists</h1>
              <p className="allowlists-subtitle">Control who sees your private answers</p>
            </div>
          </div>
        </div>

        {/* Manager Component */}
        <div className="allowlists-content">
          <AllowlistManager />
        </div>
      </div>
    </div>
  );
};

export default AllowlistsPage;

