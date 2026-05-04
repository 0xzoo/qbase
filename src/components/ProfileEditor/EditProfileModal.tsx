/**
 * EditProfileModal
 *
 * Modal for editing profile fields: username, display name, bio, avatar.
 * Reuses UsernameInput and AvatarUploader components.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Save } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { UsernameInput } from '../Onboarding/UsernameInput';
import { AvatarUploader } from '../Onboarding/AvatarUploader';
import '../Onboarding/UsernameInput.css';
import '../Onboarding/AvatarUploader.css';
import './EditProfileModal.css';

interface EditProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const EditProfileModal: React.FC<EditProfileModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { user, setUserData } = useAuth();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Initialize from current user data
  useEffect(() => {
    if (isOpen && user) {
      setUsername(user.username || '');
      setDisplayName(user.displayName || '');
      setBio(user.bio || '');
      setError(null);
      setSuccess(false);
    }
  }, [isOpen, user]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const token = user?.sessionToken || user?.quickAuthToken;
      if (!token) {
        setError('Not authenticated');
        setIsSaving(false);
        return;
      }

      const updates: Record<string, string> = {};
      if (username) updates.username = username;
      if (displayName) updates.display_name = displayName;
      if (bio.trim()) updates.bio = bio.trim();

      if (Object.keys(updates).length === 0) {
        setError('Nothing changed');
        setIsSaving(false);
        return;
      }

      const res = await fetch('/api/users/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(updates),
      });

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        if (err.error === 'Username already taken') {
          setError('That username is taken');
        } else {
          setError(err.error || 'Failed to save');
        }
        setIsSaving(false);
        return;
      }

      const data = await res.json();
      if (data.user) {
        setUserData({
          username: data.user.username,
          displayName: data.user.display_name,
          bio: data.user.bio,
          pfpUrl: data.user.pfp_url || user?.pfpUrl,
        });
      }
      setSuccess(true);
      setTimeout(onClose, 800);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  }, [username, displayName, bio, user, setUserData, isSaving, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="edit-profile-modal-overlay" onClick={onClose}>
      <div className="edit-profile-modal-container" onClick={(e) => e.stopPropagation()}>
        <button className="ep-close-btn" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>

        <h2 className="ep-title">Edit Profile</h2>

        <div className="ep-section">
          <label className="ep-label">Avatar</label>
          <AvatarUploader
            currentAvatarUrl={user?.pfpUrl || null}
            onUpload={(url) => {
              setUserData({ pfpUrl: url });
            }}
            onRemove={() => {
              setUserData({ pfpUrl: undefined });
            }}
            showRemove
          />
        </div>

        <div className="ep-section">
          <label className="ep-label">Username</label>
          <UsernameInput
            initialValue={username}
            onChange={setUsername}
          />
        </div>

        <div className="ep-section">
          <label className="ep-label">Display Name</label>
          <input
            className="ep-input"
            placeholder="Your display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={50}
          />
        </div>

        <div className="ep-section">
          <label className="ep-label">Bio</label>
          <textarea
            className="ep-textarea"
            placeholder="A short bio..."
            value={bio}
            onChange={(e) => {
              if (e.target.value.length <= 280) {
                setBio(e.target.value);
              }
            }}
            maxLength={280}
            rows={3}
          />
          <div className="ep-char-count">{bio.length}/280</div>
        </div>

        {error && <div className="ep-error">{error}</div>}
        {success && <div className="ep-success">Profile saved!</div>}

        <div className="ep-actions">
          <button className="ep-cancel-btn" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button className="ep-save-btn" onClick={handleSave} disabled={isSaving}>
            <Save size={16} />
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default EditProfileModal;
