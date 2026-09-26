/**
 * SettingsPage - User Settings & Preferences
 * 
 * Allows users to configure:
 * - Default audiences
 * - Theme preferences
 * - Notification settings
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings, Eye, Bell } from 'lucide-react';
import Header from '../components/Header';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import LoadingAnimation from '../components/LoadingAnimation';
import SignInMethods from '../components/SignInMethods';
import './SettingsPage.css';

const SettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { settings, isLoading, updateSettings } = useSettings();

  if (!isAuthenticated) {
    return (
      <div className="settings-page">
        <Header showBack closeButton onBack={() => navigate(-1)} title="Settings" />
        <div className="settings-container settings-unauthenticated">
          <div className="settings-empty-icon">
            <Settings size={48} />
          </div>
          <h2>Sign in to manage your settings</h2>
          <p>Customize your qbase experience with personalized preferences.</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="settings-page">
        <Header showBack closeButton onBack={() => navigate(-1)} title="Settings" />
        <div className="settings-container">
          <div className="settings-loading">
            <LoadingAnimation variant="spinner" size="md" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <Header showBack closeButton onBack={() => navigate(-1)} title="Settings" />
      
      <div className="settings-container">
        {/* Header */}
        <div className="settings-header">
          <div className="settings-title-row">
            <div className="settings-icon">
              <Settings size={24} />
            </div>
            <h1>Settings</h1>
          </div>
          <p className="settings-subtitle">Customize your qbase experience</p>
        </div>

        <SignInMethods />

        {/* Defaults Section */}
        <section className="settings-section">
          <div className="settings-section-header">
            <Eye size={18} />
            <h2>Defaults</h2>
          </div>
          <p className="settings-section-description">
            Set your default preferences for new content
          </p>

          <div className="settings-group">
            {/* Default Answer Audience */}
            <div className="settings-item">
              <div className="settings-item-content">
                <div className="settings-item-text">
                  <span className="settings-item-label">Default answer audience</span>
                  <span className="settings-item-description">
                    Who can see your answers by default
                  </span>
                </div>
              </div>
              <select
                className="settings-select"
                value={settings.defaultAudience}
                onChange={(e) => updateSettings({ defaultAudience: e.target.value as 'Public' | 'Private' | 'Anon' | 'Allowlist' })}
              >
                <option value="Public">Public</option>
                <option value="Private">Secret</option>
                <option value="Anon">Anonymous</option>
              </select>
            </div>
          </div>
        </section>

        {/* Notifications Section (placeholder) */}
        <section className="settings-section">
          <div className="settings-section-header">
            <Bell size={18} />
            <h2>Notifications</h2>
          </div>
          <p className="settings-section-description">
            Manage your notification preferences
          </p>

          <div className="settings-group">
            <div className="settings-item">
              <div className="settings-item-content">
                <div className="settings-item-text">
                  <span className="settings-item-label">Direct questions</span>
                  <span className="settings-item-description">
                    Get notified when someone asks you a question
                  </span>
                </div>
              </div>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.notifications?.directQuestions ?? true}
                  onChange={(e) => updateSettings({ 
                    notifications: { ...settings.notifications, directQuestions: e.target.checked }
                  })}
                />
                <span className="settings-toggle-slider" />
              </label>
            </div>

            <div className="settings-item">
              <div className="settings-item-content">
                <div className="settings-item-text">
                  <span className="settings-item-label">Answers</span>
                  <span className="settings-item-description">
                    Get notified when someone answers your question
                  </span>
                </div>
              </div>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.notifications?.answers ?? true}
                  onChange={(e) => updateSettings({ 
                    notifications: { ...settings.notifications, answers: e.target.checked }
                  })}
                />
                <span className="settings-toggle-slider" />
              </label>
            </div>

            <div className="settings-item">
              <div className="settings-item-content">
                <div className="settings-item-text">
                  <span className="settings-item-label">Reactions</span>
                  <span className="settings-item-description">
                    Get notified when someone likes or recasts your content
                  </span>
                </div>
              </div>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.notifications?.reactions ?? true}
                  onChange={(e) => updateSettings({ 
                    notifications: { ...settings.notifications, reactions: e.target.checked }
                  })}
                />
                <span className="settings-toggle-slider" />
              </label>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default SettingsPage;
