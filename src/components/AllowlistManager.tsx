import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Users, X, Edit2, RefreshCw, UserPlus, Heart } from 'lucide-react';
import type { AllowlistWithMembers, AllowlistType } from '../lib/types';
import './AllowlistManager.css';

interface AllowlistManagerProps {
  apiBaseUrl?: string;
}

const AllowlistManager: React.FC<AllowlistManagerProps> = ({ apiBaseUrl = '/api' }) => {
  const [allowlists, setAllowlists] = useState<AllowlistWithMembers[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [listType, setListType] = useState<AllowlistType>('manual');
  const [members, setMembers] = useState<number[]>([]); // Internal user IDs
  const [newMemberFid, setNewMemberFid] = useState('');
  const [importLimit, setImportLimit] = useState(50);
  const [importing, setImporting] = useState(false);

  // Fetch allowlists on mount
  useEffect(() => {
    fetchAllowlists();
  }, []);

  const fetchAllowlists = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${apiBaseUrl}/allowlists`, {
        headers: {
          'Authorization': `Bearer ${getAuthToken()}`,
        },
      });

      if (!response.ok) throw new Error('Failed to fetch allowlists');

      const data = await response.json() as AllowlistWithMembers[];
      setAllowlists(data);
      setError(null);
    } catch (err: unknown) {
      const error = err as { message?: string };
      setError(error.message || 'Failed to fetch allowlists');
      console.error('Error fetching allowlists:', err);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setName('');
    setDescription('');
    setListType('manual');
    setMembers([]);
    setNewMemberFid('');
    setImportLimit(50);
    setIsCreating(false);
    setEditingId(null);
  };

  const handleCreateStart = () => {
    resetForm();
    setIsCreating(true);
  };

  const handleEditStart = (list: AllowlistWithMembers) => {
    // Only manual lists can be edited
    if (list.list_type !== 'manual') {
      alert('Only manual allowlists can be edited');
      return;
    }

    setName(list.name);
    setDescription(list.description || '');
    setListType(list.list_type);
    setMembers(list.memberIds || []);
    setEditingId(list.id);
    setIsCreating(true);
  };

  const handleAddMember = () => {
    const fid = parseInt(newMemberFid.trim());
    if (!isNaN(fid) && !members.includes(fid)) {
      if (members.length >= 100) {
        alert('Manual allowlists cannot exceed 100 members');
        return;
      }
      setMembers([...members, fid]);
      setNewMemberFid('');
    }
  };

  const handleRemoveMember = (memberToRemove: number) => {
    setMembers(members.filter(m => m !== memberToRemove));
  };

  const handleImportFromNeynar = async () => {
    if (!name.trim()) {
      alert('Please enter a name for the allowlist first');
      return;
    }

    try {
      setImporting(true);

      // Get current user's FID from auth
      const fid = await getCurrentUserFid();

      const response = await fetch(`${apiBaseUrl}/allowlists/import/besties`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getAuthToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fid,
          name,
          description,
          limit: importLimit,
        }),
      });

      if (!response.ok) throw new Error('Failed to import besties');

      const newList = await response.json() as AllowlistWithMembers;
      setAllowlists([...allowlists, newList]);
      resetForm();
      alert('Besties imported successfully!');
    } catch (err: unknown) {
      const error = err as { message?: string };
      alert(`Import failed: ${error.message}`);
      console.error('Error importing besties:', err);
    } finally {
      setImporting(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      alert('Please enter a name');
      return;
    }

    try {
      if (editingId) {
        // Update existing allowlist
        const response = await fetch(`${apiBaseUrl}/allowlists/${editingId}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${getAuthToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name,
            description,
            members,
          }),
        });

        if (!response.ok) throw new Error('Failed to update allowlist');

        const updated = await response.json() as AllowlistWithMembers;
        setAllowlists(allowlists.map(list => list.id === editingId ? updated : list));
      } else {
        // Create new allowlist
        const fid = listType === 'manual' ? undefined : await getCurrentUserFid();

        const response = await fetch(`${apiBaseUrl}/allowlists`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${getAuthToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name,
            description,
            list_type: listType,
            source_params: fid ? { fid } : undefined,
            members: listType === 'manual' ? members : undefined,
          }),
        });

        if (!response.ok) throw new Error('Failed to create allowlist');

        const newList = await response.json() as AllowlistWithMembers;
        setAllowlists([...allowlists, newList]);
      }

      resetForm();
    } catch (err: unknown) {
      const error = err as { message?: string };
      alert(`Save failed: ${error.message}`);
      console.error('Error saving allowlist:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this allowlist?')) return;

    try {
      const response = await fetch(`${apiBaseUrl}/allowlists/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${getAuthToken()}`,
        },
      });

      if (!response.ok) throw new Error('Failed to delete allowlist');

      setAllowlists(allowlists.filter(list => list.id !== id));
    } catch (err: unknown) {
      const error = err as { message?: string };
      alert(`Delete failed: ${error.message}`);
      console.error('Error deleting allowlist:', err);
    }
  };

  const handleRefresh = async (id: string) => {
    try {
      const response = await fetch(`${apiBaseUrl}/allowlists/${id}/refresh`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getAuthToken()}`,
        },
      });

      if (!response.ok) throw new Error('Failed to refresh allowlist');

      const updated = await response.json() as AllowlistWithMembers;
      setAllowlists(allowlists.map(list => list.id === id ? updated : list));
      alert('Allowlist refreshed!');
    } catch (err: unknown) {
      const error = err as { message?: string };
      alert(`Refresh failed: ${error.message}`);
      console.error('Error refreshing allowlist:', err);
    }
  };

  const getAuthToken = (): string => {
    // TODO: Get auth token from your auth context/provider
    return localStorage.getItem('authToken') || '';
  };

  const getCurrentUserFid = async (): Promise<number> => {
    // TODO: Get current user's FID from your auth context
    // This is a placeholder
    return parseInt(localStorage.getItem('userFid') || '0');
  };

  const getListTypeLabel = (type: AllowlistType): string => {
    const labels: Record<AllowlistType, string> = {
      manual: 'Custom List',
      my_followers: 'My Followers',
      my_following: 'My Following',
      mutual_followers: 'Mutual Followers',
      besties: 'My Besties',
    };
    return labels[type];
  };

  const getListTypeIcon = (type: AllowlistType) => {
    const icons: Record<AllowlistType, React.ReactNode> = {
      manual: <Users size={14} />,
      my_followers: <UserPlus size={14} />,
      my_following: <UserPlus size={14} />,
      mutual_followers: <Users size={14} />,
      besties: <Heart size={14} />,
    };
    return icons[type];
  };

  if (loading) return <div className="allowlist-manager loading">Loading...</div>;

  return (
    <div className="allowlist-manager">
      <div className="manager-header">
        <h3>My Allowlists</h3>
        {!isCreating && (
          <button className="create-btn" onClick={handleCreateStart}>
            <Plus size={16} /> New Allowlist
          </button>
        )}
      </div>

      {error && <div className="error-message">{error}</div>}

      {isCreating ? (
        <div className="allowlist-form">
          <div className="form-group">
            <label>List Type</label>
            <select
              value={listType}
              onChange={(e) => setListType(e.target.value as AllowlistType)}
              disabled={!!editingId} // Can't change type when editing
            >
              <option value="manual">Custom List</option>
              <option value="my_followers">My Followers (Dynamic)</option>
              <option value="my_following">My Following (Dynamic)</option>
              <option value="mutual_followers">Mutual Followers (Dynamic)</option>
              <option value="besties">My Besties (Top N)</option>
            </select>
            <small className="form-hint">
              {listType === 'manual' && 'Create a custom list with specific members (max 100)'}
              {listType === 'my_followers' && 'Anyone who follows you can view (no stored members)'}
              {listType === 'my_following' && 'Anyone you follow can view (no stored members)'}
              {listType === 'mutual_followers' && 'Anyone you mutually follow can view (no stored members)'}
              {listType === 'besties' && 'Import your top friends from Farcaster (max 50, refresh-able)'}
            </small>
          </div>

          <div className="form-group">
            <label>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`e.g., ${getListTypeLabel(listType)}`}
              autoFocus
            />
          </div>

          <div className="form-group">
            <label>Description (Optional)</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>

          {listType === 'manual' && (
            <div className="form-group">
              <label>Members (FIDs)</label>
              <div className="member-input-row">
                <input
                  type="number"
                  value={newMemberFid}
                  onChange={(e) => setNewMemberFid(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddMember()}
                  placeholder="Enter Farcaster ID"
                />
                <button className="add-member-btn" onClick={handleAddMember} disabled={!newMemberFid.trim()}>
                  Add
                </button>
              </div>

              <div className="members-list">
                {members.map(member => (
                  <div key={member} className="member-tag">
                    <span>FID: {member}</span>
                    <button onClick={() => handleRemoveMember(member)}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
                {members.length === 0 && (
                  <div className="empty-members">No members added yet</div>
                )}
                <small className="member-count">
                  {members.length} / 100 members
                </small>
              </div>
            </div>
          )}

          {listType === 'besties' && (
            <>
              <div className="form-group">
                <label>Import Limit</label>
                <input
                  type="number"
                  value={importLimit}
                  onChange={(e) => setImportLimit(parseInt(e.target.value) || 50)}
                  min="1"
                  max="50"
                />
                <small className="form-hint">Number of besties to import (1-50)</small>
              </div>

              <button
                className="import-btn"
                onClick={handleImportFromNeynar}
                disabled={importing}
              >
                {importing ? 'Importing...' : 'Import from Farcaster'}
              </button>
            </>
          )}

          <div className="form-actions">
            <button className="cancel-btn" onClick={resetForm}>Cancel</button>
            <button
              className="save-btn"
              onClick={handleSave}
              disabled={!name.trim() || (listType === 'manual' && members.length === 0)}
            >
              {editingId ? 'Update Allowlist' : 'Create Allowlist'}
            </button>
          </div>
        </div>
      ) : (
        <div className="allowlists-grid">
          {allowlists.map(list => (
            <div key={list.id} className="allowlist-card">
              <div className="card-header">
                <div className="card-title">
                  <div className="title-row">
                    {getListTypeIcon(list.list_type)}
                    <h4>{list.name}</h4>
                  </div>
                  <span className="list-type-badge">{getListTypeLabel(list.list_type)}</span>
                </div>
                <div className="card-actions">
                  {list.list_type === 'besties' && (
                    <button onClick={() => handleRefresh(list.id)} title="Refresh from Farcaster">
                      <RefreshCw size={14} />
                    </button>
                  )}
                  {list.list_type === 'manual' && (
                    <button onClick={() => handleEditStart(list)} title="Edit">
                      <Edit2 size={14} />
                    </button>
                  )}
                  <button onClick={() => handleDelete(list.id)} title="Delete" className="delete-btn">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {list.description && <p className="card-desc">{list.description}</p>}
              <div className="card-footer">
                {list.list_type === 'manual' || list.list_type === 'besties' ? (
                  <span className="member-count">
                    <Users size={12} /> {list.memberCount || 0} members
                  </span>
                ) : (
                  <span className="dynamic-badge">Dynamic membership</span>
                )}
              </div>
            </div>
          ))}
          {allowlists.length === 0 && (
            <div className="empty-state">
              <p>You haven't created any allowlists yet.</p>
              <button className="text-btn" onClick={handleCreateStart}>Create one now</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AllowlistManager;
