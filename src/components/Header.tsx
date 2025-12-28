import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Sun, Moon, User } from 'lucide-react';
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
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    // Close dropdown when clicking outside
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [dropdownOpen]);

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
      setDropdownOpen(!dropdownOpen);
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
        {isAuthenticated && user ? (
          <div className="user-menu-container" ref={dropdownRef}>
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
            </div>
            
            {dropdownOpen && (
              <div 
                className="user-dropdown"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                <span className="username">{user.username}</span>
                <div 
                  className="dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate('/me');
                    setDropdownOpen(false);
                  }}
                >
                  <User size={18} />
                  <span>Profile</span>
                </div>
                <div 
                  className="dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleTheme();
                    setDropdownOpen(false);
                  }}
                >
                  {isDark ? <Sun size={18} /> : <Moon size={18} />}
                  <span>{isDark ? 'Light Mode' : 'Dark Mode'}</span>
                </div>
              </div>
            )}
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
