/**
 * HandlePrompt
 *
 * Asks an account without a handle to pick one: once per session after its
 * first contribution (CONTRIBUTED_EVENT), and whenever something opens it on
 * purpose (PICK_HANDLE_EVENT: the header's Profile item, Settings). Accounts
 * that came with a name (Farcaster fname, verified ENS) already have one and
 * are never nudged. Server rules: worker/services/accounts/HandleService.ts.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { X, AtSign } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../lib/apiClient';
import { CONTRIBUTED_EVENT, PICK_HANDLE_EVENT, suggestHandle, type PickHandleDetail } from '../lib/handlePrompt';
import { UsernameInput } from './Onboarding/UsernameInput';
import './Onboarding/UsernameInput.css';
import './ProfileEditor/EditProfileModal.css';

const DISMISSED_KEY = 'qbase:handle-prompt-dismissed';

function dismissedThisSession(): boolean {
  try { return sessionStorage.getItem(DISMISSED_KEY) === '1'; } catch { return false; }
}

export const HandlePrompt: React.FC = () => {
  const navigate = useNavigate();
  const { accountId, handle, user, fetchOwnProfile } = useAuth();
  const [open, setOpen] = useState(false);
  const [goToProfile, setGoToProfile] = useState(false);
  const [value, setValue] = useState('');
  const [valid, setValid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onContributed = () => {
      if (accountId !== null && handle === null && !dismissedThisSession()) {
        setGoToProfile(false);
        setOpen(true);
      }
    };
    const onPick = (e: Event) => {
      if (accountId === null) return;
      setGoToProfile(!!(e as CustomEvent<PickHandleDetail>).detail?.goToProfile);
      setOpen(true);
    };
    window.addEventListener(CONTRIBUTED_EVENT, onContributed);
    window.addEventListener(PICK_HANDLE_EVENT, onPick);
    return () => {
      window.removeEventListener(CONTRIBUTED_EVENT, onContributed);
      window.removeEventListener(PICK_HANDLE_EVENT, onPick);
    };
  }, [accountId, handle]);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const close = useCallback(() => {
    try { sessionStorage.setItem(DISMISSED_KEY, '1'); } catch { /* private mode */ }
    setOpen(false);
  }, []);

  const save = useCallback(async () => {
    if (saving || !valid || !value) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiClient.authenticatedFetch('/api/users/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error || 'Could not save that handle');
        return;
      }
      await fetchOwnProfile();
      setOpen(false);
      if (goToProfile) navigate(`/ask/${value}`);
    } catch {
      setError('Could not save that handle');
    } finally {
      setSaving(false);
    }
  }, [saving, valid, value, fetchOwnProfile, goToProfile, navigate]);

  if (!open || accountId === null) return null;

  const initial = handle ?? suggestHandle(user?.username, user?.displayName);

  return createPortal(
    <div className="edit-profile-modal-overlay" onClick={close}>
      <div className="edit-profile-modal-container" onClick={(e) => e.stopPropagation()}>
        <button className="ep-close-btn" onClick={close} aria-label="Close">
          <X size={20} />
        </button>
        <h2 className="ep-title">{handle ? 'Your handle' : 'Pick your handle'}</h2>
        <p className="text-sm text-center text-gray-500 dark:text-gray-400 mb-5">
          Your name on qbase, whatever you signed in with. Your profile lives at
          <span className="whitespace-nowrap"> qbase.tech/ask/{value || 'you'}</span>.
        </p>
        <div className="ep-section">
          <label className="ep-label flex items-center gap-1"><AtSign size={14} /> Handle</label>
          <UsernameInput
            key={initial}
            initialValue={initial}
            currentHandle={handle ?? null}
            onChange={setValue}
            onValidityChange={setValid}
            autoFocus
          />
        </div>
        {error && <div className="ep-error">{error}</div>}
        <div className="ep-actions">
          <button className="ep-cancel-btn" onClick={close} disabled={saving}>
            {handle ? 'Cancel' : 'Later'}
          </button>
          <button className="ep-save-btn" onClick={save} disabled={saving || !valid || !value || value === handle}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default HandlePrompt;
