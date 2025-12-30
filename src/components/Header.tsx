import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Sun, Moon, User, Key, Plus } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useSignIn } from '@farcaster/auth-kit';
import { SignerSetupModal } from './SignerSetupModal';
import { apiClient } from '../lib/apiClient';
import './Header.css';

interface HeaderProps {
  showBack?: boolean;
  backLabel?: string;
  onBack?: () => void;
}

const Header: React.FC<HeaderProps> = ({ showBack, backLabel = 'Back', onBack }) => {
  const navigate = useNavigate();
  const { user, isAuthenticated, login, isMiniApp, miniAppAdded, addMiniApp, hasSigner } = useAuth();
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
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, right: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const userPillRef = useRef<HTMLDivElement>(null);
  const [points, setPoints] = useState<{ allowance: number; earned: number } | null>(null);
  const [nonce, setNonce] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [shouldSignIn, setShouldSignIn] = useState(false);

  // Fetch nonce when needed for web auth
  const fetchNonce = async () => {
    try {
      const response = await fetch('/api/auth/nonce');
      if (!response.ok) {
        throw new Error('Failed to fetch nonce');
      }
      const data = await response.json() as { nonce: string };
      setNonce(data.nonce);
      return data.nonce;
    } catch (error) {
      console.error('Error fetching nonce:', error);
      return null;
    }
  };

  // AuthKit sign-in hook with proper nonce
  const { signIn, isSuccess } = useSignIn({
    nonce: nonce || undefined,
    onSuccess: async (res) => {
      console.log(`Signed in as ${res.username} (${res.fid})`);
      setIsSigningIn(false);
      setShouldSignIn(false);
      // The AuthContext will automatically pick up the authentication via useProfile
    },
    onError: (error) => {
      console.error('Sign in error:', error);
      setIsSigningIn(false);
      setShouldSignIn(false);
    },
  });

  // Trigger sign-in when nonce is ready
  useEffect(() => {
    if (shouldSignIn && nonce) {
      signIn();
    }
  }, [shouldSignIn, nonce, signIn]);

  // Handle sign-in button click
  const handleSignIn = async () => {
    setIsSigningIn(true);
    setShouldSignIn(true);
    // Fetch nonce first, which will trigger sign-in via useEffect
    await fetchNonce();
  };

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

  // Fetch user points when authenticated
  useEffect(() => {
    if (!isAuthenticated || !user) {
      setPoints(null);
      return;
    }

    const fetchPoints = async () => {
      try {
        const response = await apiClient.get('/api/points');
        if (response.ok) {
          const data = await response.json() as { allowance: number; earned: number; balance: number };
          setPoints({
            allowance: data.allowance,
            earned: data.earned
          });
        } else {
          console.error('Failed to fetch points:', response.statusText);
          // Set default values on error
          setPoints({ allowance: 0, earned: 0 });
        }
      } catch (error) {
        console.error('Error fetching points:', error);
        // Set default values on error
        setPoints({ allowance: 0, earned: 0 });
      }
    };

    fetchPoints();
  }, [isAuthenticated, user]);

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
                  navigate('/qq');
                }}
                style={{ cursor: 'pointer' }}
              >
                {points ? `${points.allowance} | ${points.earned}` : '-- | --'}
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
                    navigate('/me');
                    setDropdownOpen(false);
                  }}
                >
                  <User size={18} />
                  <span>Profile</span>
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
              </div>,
              document.body
            )}
          </div>
        ) : isMiniApp ? (
          <div className="user-pill" onClick={handleUserPillClick} style={{ cursor: 'pointer' }}>
            <span className="username">Connect</span>
          </div>
        ) : (
          <button 
            className="sign-in-button" 
            onClick={handleSignIn}
            disabled={isSigningIn}
            style={{ 
              cursor: isSigningIn ? 'wait' : 'pointer',
              padding: '8px 16px',
              borderRadius: '8px',
              border: 'none',
              background: 'var(--primary-color, #8b5cf6)',
              color: 'white',
              fontWeight: '500',
              fontSize: '14px'
            }}
          >
            {isSigningIn ? 'Connecting...' : 'Sign in'}
          </button>
        )}
      </div>

      <SignerSetupModal
        isOpen={showSignerModal}
        onClose={() => setShowSignerModal(false)}
        action="perform Farcaster actions"
      />
    </header>
  );
};

export default Header;
