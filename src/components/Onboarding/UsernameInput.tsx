/**
 * UsernameInput
 *
 * Username picker with real-time validation and availability checking.
 * Used by OnboardingPage and profile edit flows.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, XCircle, Loader2, AlertCircle } from 'lucide-react';
import './UsernameInput.css';

const DEBOUNCE_MS = 500;
const USERNAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

type ValidationState = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

interface UsernameInputProps {
  initialValue?: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

export const UsernameInput: React.FC<UsernameInputProps> = ({
  initialValue = '',
  onChange,
  autoFocus = false,
}) => {
  const [value, setValue] = useState(initialValue);
  const [validation, setValidation] = useState<ValidationState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>[]> ([]);

  const checkUsername = useCallback(async (username: string) => {
    if (username.length < 3) {
      setValidation('invalid');
      setErrorMessage('Username must be at least 3 characters');
      return;
    }

    if (!USERNAME_REGEX.test(username)) {
      setValidation('invalid');
      if (/^-|-$/i.test(username)) {
        setErrorMessage('Cannot start or end with a hyphen');
      } else if (/[^a-z0-9-]/.test(username)) {
        setErrorMessage('Only lowercase letters, numbers, and hyphens');
      } else if (username.length > 20) {
        setErrorMessage('Username must be 20 characters or fewer');
      } else {
        setErrorMessage('Invalid username format');
      }
      return;
    }

    setValidation('checking');
    setErrorMessage('');

    try {
      const res = await fetch('/api/users/check-username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });

      const data = await res.json();
      if (data.available) {
        setValidation('available');
        setErrorMessage('');
      } else {
        setValidation('taken');
        setErrorMessage(data.reason || 'Username is taken');
      }
    } catch {
      setValidation('invalid');
      setErrorMessage('Could not check availability');
    }
  }, []);

  // Debounced availability check
  useEffect(() => {
    // Clear previous debounce timers
    debounceRef.current.forEach(clearTimeout);
    debounceRef.current = [];

    const trimmed = value.toLowerCase().trim();

    if (!trimmed || trimmed.length < 3 || !USERNAME_REGEX.test(trimmed)) {
      if (!trimmed) {
        setValidation('idle');
      } else if (trimmed.length < 3) {
        setValidation('invalid');
        setErrorMessage('At least 3 characters');
      } else {
        setValidation('invalid');
        if (/[^a-z0-9-]/.test(trimmed)) {
          setErrorMessage('Only lowercase letters, numbers, and hyphens');
        } else {
          setErrorMessage('Invalid format');
        }
      }
      return;
    }

    setValidation('checking');
    const timer = setTimeout(() => {
      checkUsername(trimmed);
    }, DEBOUNCE_MS);
    debounceRef.current.push(timer);

    return () => {
      clearTimeout(timer);
    };
  }, [value, checkUsername]);

  // Fire onChange to parent
  useEffect(() => {
    onChange(value);
  }, [value, onChange]);

  const validationIcon = () => {
    switch (validation) {
      case 'checking':
        return <Loader2 size={18} className="animate-spin text-gray-400" />;
      case 'available':
        return <CheckCircle size={18} className="text-emerald-500" />;
      case 'taken':
        return <XCircle size={18} className="text-red-500" />;
      case 'invalid':
        return <AlertCircle size={18} className="text-amber-500" />;
      default:
        return null;
    }
  };

  const borderColor = () => {
    switch (validation) {
      case 'available': return 'border-emerald-400 focus:border-emerald-500';
      case 'taken': return 'border-red-400 focus:border-red-500';
      case 'invalid': return 'border-amber-400 focus:border-amber-500';
      case 'checking': return 'border-blue-400 focus:border-blue-500';
      default: return '';
    }
  };

  return (
    <div className="w-full">
      <div className="relative">
        <input
          type="text"
          className={`username-input ${borderColor()}`}
          placeholder="e.g. raccoon-42"
          value={value}
          onChange={(e) => {
            // Auto-lowercase and strip invalid chars
            const cleaned = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
            setValue(cleaned);
          }}
          maxLength={20}
          autoFocus={autoFocus}
          autoComplete="username"
          spellCheck={false}
        />
        {validation !== 'idle' && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {validationIcon()}
          </div>
        )}
      </div>
      {errorMessage && (
        <p className="username-error">{errorMessage}</p>
      )}
      {(validation === 'available') && (
        <p className="username-success">Username is available!</p>
      )}
      <p className="username-hint">
        3&ndash;20 characters, lowercase letters, numbers, and hyphens only
      </p>
    </div>
  );
};
