import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Sun, Moon, User, Key, Plus, LogOut, Shield, Bell, Settings, Fingerprint } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { SignInButton, type StatusAPIResponse } from '@farcaster/auth-kit';
import { SignerSetupModal } from './SignerSetupModal';
import { PointsModal } from './PointsModal';
import { usePoints } from '../hooks/usePoints';
import './Header.css';

interface HeaderProps {
  showBack?: boolean;
  backLabel?: string;
  onBack?: () => void;
  title?: string;
}

const Header: React.FC<HeaderProps> = ({ showBack, backLabel = 'Back', onBack, title }) => {
  const navigate = useNavigate();
  const {
    user,
    isAuthenticated,
    login,
    logout,
    setUserData,
    isMiniApp,
    miniAppAdded,
    addMiniApp,
    hasSigner,
    authUrl,
    isAuthPolling,
    cancelAuth,
    handleWebAuth,
    loginWithPasskey,
  } = useAuth();
  const [isDark, setIsDark] = useState(() => {
    // Check localStorage or system preference
    const saved = localStorage.getItem('theme');
    if (saved) {
      return saved === 'dark';
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [showPointsModal, setShowPointsModal] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, right: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const userPillRef = useRef<HTMLDivElement>(null);
  
  // Use cached points hook instead of manual fetch
  const { points } = usePoints();

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
    // Calculate dropdown position when it opens
    if (dropdownOpen && userPillRef.current) {
      const rect = userPillRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      });
    }
  }, [dropdownOpen]);

  useEffect(() => {
    // Close dropdown when clicking outside
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        userPillRef.current &&
        !userPillRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(false);
      }
    };

    if (dropdownOpen) {
      // Use a small delay to avoid closing immediately when opening
      const timeoutId = setTimeout(() => {
        document.addEventListener('click', handleClickOutside, true);
      }, 0);

      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener('click', handleClickOutside, true);
      };
    }
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
    } else {
      login();
    }
  };

  const handleMenuToggle = () => {
    setMenuOpen(!menuOpen);
  };

  const handleNavClick = (path: string) => {
    navigate(path);
    setMenuOpen(false);
  };

  return (
    <>
      {/* Hamburger menu button - mobile only, outside header for proper z-index */}
      {!showBack && (
        <button 
          className={`hamburger-button ${menuOpen ? 'open' : ''}`}
          onClick={handleMenuToggle}
          aria-label="Toggle menu"
        >
          <span className="hamburger-line"></span>
          <span className="hamburger-line"></span>
          <span className="hamburger-line"></span>
        </button>
      )}

      <header className="header">
        {showBack ? (
          <div className="back-link" onClick={handleBack} style={{ cursor: 'pointer' }}>
            <ChevronLeft size={24} />
            <span>{backLabel}</span>
          </div>
        ) : (
          <>
            {/* Page title - mobile only */}
            {title && <h1 className="page-title-mobile">{title}</h1>}

            <div className="logo-container">
              <img src="/qbase.svg" alt="qbase logo" className="header-logo-image" />
            </div>
          </>
        )}

      <div className="header-right">
        {isAuthenticated && user ? (
          <div className="user-menu-container">
            <div
              ref={userPillRef}
              className="user-pill"
              onClick={handleUserPillClick}
              style={{ cursor: 'pointer' }}
            >
              <span
                className="stats"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowPointsModal(true);
                }}
                style={{ cursor: 'pointer' }}
                title={`Spendable: ${points ? (points.allowance || 0) + (points.balance || 0) : 0} QP | Earned (monthly): ${points ? (points.earned || 0) : 0} QP`}
              >
                {points ? `${(points.allowance || 0) + (points.balance || 0)} | ${points.earned || 0}` : '-- | --'}
              </span>
              <div className="avatar">
                <img src={user.pfpUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.username}`} alt="user avatar" />
              </div>
            </div>

            {dropdownOpen && createPortal(
              <div
                ref={dropdownRef}
                className="user-dropdown"
                style={{
                  position: 'fixed',
                  top: `${dropdownPosition.top}px`,
                  right: `${dropdownPosition.right}px`,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                }}
              >
                <span className="username">{user.username}</span>
                <div
                  className="dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/ask/${user.username}`);
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
                    navigate('/vault');
                    setDropdownOpen(false);
                  }}
                >
                  <Shield size={18} />
                  <span>My Vault</span>
                </div>
                <div
                  className="dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate('/notifications');
                    setDropdownOpen(false);
                  }}
                >
                  <Bell size={18} />
                  <span>Notifications</span>
                </div>
                <div
                  className="dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate('/settings');
                    setDropdownOpen(false);
                  }}
                >
                  <Settings size={18} />
                  <span>Settings</span>
                </div>
                {isMiniApp && !miniAppAdded && (
                  <div
                    className="dropdown-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDropdownOpen(false);
                      addMiniApp();
                    }}
                  >
                    <Plus size={18} />
                    <span>Add miniapp</span>
                  </div>
                )}
                {!hasSigner && (
                  <div
                    className="dropdown-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDropdownOpen(false);
                      setShowSignerModal(true);
                    }}
                  >
                    <Key size={18} />
                    <span>Add signer</span>
                  </div>
                )}
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
                <div
                  className="dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDropdownOpen(false);
                    logout();
                  }}
                >
                  <LogOut size={18} />
                  <span>Logout</span>
                </div>
              </div>,
              document.body
            )}
          </div>
        ) : isMiniApp ? (
          <div style={{ display: 'inline-block' }}>
            <SignInButton
              onSuccess={(res: StatusAPIResponse) => {
                if (handleWebAuth) {
                  handleWebAuth(res);
                }
              }}
              onError={(error) => {
                console.error('[Header] SignInButton error:', error);
              }}
            />
          </div>
        ) : (
          <button
            className="passkey-login-btn primary"
            onClick={loginWithPasskey}
            title="Sign in with Passkey"
          >
            <Fingerprint size={18} />
            <span>Sign in</span>
          </button>
        )}
      </div>

      <SignerSetupModal
        isOpen={showSignerModal}
        onClose={() => setShowSignerModal(false)}
        action="perform Farcaster actions"
      />

      <PointsModal
        isOpen={showPointsModal}
        onClose={() => setShowPointsModal(false)}
        points={points}
      />
    </header>

      {/* Full-screen mobile navigation menu */}
      {menuOpen && createPortal(
        <div className="mobile-nav-overlay" onClick={handleMenuToggle}>
          <div className="mobile-nav-menu" onClick={(e) => e.stopPropagation()}>
            <nav className="mobile-nav-links">
              <span className="mobile-nav-link" onClick={() => handleNavClick('/')}>home</span>
              <span className="mobile-nav-link" onClick={() => handleNavClick('/questions')}>questions</span>
              <span className="mobile-nav-link" onClick={() => handleNavClick('/answers')}>answers</span>
              <span className="mobile-nav-link" onClick={() => handleNavClick('/topics')}>topics</span>
              <span className="mobile-nav-link" onClick={() => handleNavClick('/quizzes')}>quizzes</span>
              <span className="mobile-nav-link" onClick={() => handleNavClick('/about')}>about</span>
            </nav>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default Header;
