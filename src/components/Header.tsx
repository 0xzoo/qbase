import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Sun, Moon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { SignInButton } from '@farcaster/auth-kit';
import './Header.css';

interface HeaderProps {
  showBack?: boolean;
  backLabel?: string;
  onBack?: () => void;
}

const Header: React.FC<HeaderProps> = ({ showBack, backLabel = 'Back', onBack }) => {
  const navigate = useNavigate();
  const { user, isAuthenticated, login, isMiniApp } = useAuth();
  const [isDark, setIsDark] = useState(() => {
    // Check localStorage or system preference
    const saved = localStorage.getItem('theme');
    if (saved) {
      return saved === 'dark';
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    // Apply theme to document
    if (isDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('theme', 'light');
    }
  }, [isDark]);

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      navigate(-1);
    }
  };

  const toggleTheme = () => {
    setIsDark(!isDark);
  };

  const handleUserPillClick = () => {
    if (isAuthenticated) {
      navigate('/me');
    } else if (isMiniApp) {
      // In MiniApp context, use Quick Auth
      login();
    }
    // For non-authenticated users in web context, the SignInButton will handle the click
  };

  return (
    <header className="header">
      {showBack ? (
        <div className="back-link" onClick={handleBack} style={{ cursor: 'pointer' }}>
          <ChevronLeft size={24} />
          <span>{backLabel}</span>
        </div>
      ) : (
        <div className="logo-container">
          <img src="/qbase.svg" alt="qbase logo" className="header-logo-image" />
        </div>
      )}

      <div className="header-right">
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          {isDark ? <Sun size={20} /> : <Moon size={20} />}
        </button>

        {isAuthenticated && user ? (
          <div className="user-pill" onClick={handleUserPillClick} style={{ cursor: 'pointer' }}>
            <span
              className="stats"
              onClick={(e) => {
                e.stopPropagation();
                navigate('/qq');
              }}
              style={{ cursor: 'pointer' }}
            >
              51 | 0
            </span>
            <div className="avatar">
              <img src={user.pfpUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.username}`} alt="user avatar" />
            </div>
            <span className="username">{user.username}</span>
          </div>
        ) : isMiniApp ? (
          <div className="user-pill" onClick={handleUserPillClick} style={{ cursor: 'pointer' }}>
            <span className="username">Connect</span>
          </div>
        ) : (
          <SignInButton
            onSuccess={({ fid, username }) => {
              console.log(`Signed in as ${username} (${fid})`);
              // The AuthContext will automatically pick up the authentication
            }}
            onError={(error) => {
              console.error('Sign in error:', error);
            }}
          />
        )}
      </div>
    </header>
  );
};

export default Header;
