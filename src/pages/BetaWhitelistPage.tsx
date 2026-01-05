/**
 * BetaWhitelistPage - Admin page for managing beta whitelist
 * 
 * Only accessible to admin users. Allows adding/removing FIDs
 * from the beta whitelist individually or in bulk.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, Plus, Users, AlertCircle, Check, X as XIcon } from 'lucide-react';
import Header from '../components/Header';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../lib/apiClient';
import './BetaWhitelistPage.css';

interface WhitelistEntry {
  id: number;
  fid: number;
  fname: string | null;
  added_by_fid: number | null;
  added_at: number;
  notes: string | null;
}

const BetaWhitelistPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, user } = useAuth();
  const [entries, setEntries] = useState<WhitelistEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  
  // Form state
  const [singleFid, setSingleFid] = useState('');
  const [bulkFids, setBulkFids] = useState('');
  const [notes, setNotes] = useState('');
  const [addMode, setAddMode] = useState<'single' | 'bulk'>('single');
  const [addStatus, setAddStatus] = useState<{ success?: string; error?: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  const loadWhitelist = useCallback(async () => {
    try {
      const response = await apiClient.get('/api/admin/beta-whitelist?limit=200');
      if (response.ok) {
        const data = await response.json() as { entries: WhitelistEntry[]; total: number };
        setEntries(data.entries);
        setTotal(data.total);
      } else if (response.status === 403) {
        setIsAdmin(false);
        setError('You do not have admin access');
      } else {
        setError('Failed to load whitelist');
      }
    } catch (err) {
      setError('Failed to load whitelist');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Check admin status and load whitelist
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    const checkAccess = async () => {
      try {
        const response = await apiClient.get('/api/beta/check');
        if (response.ok) {
          const data = await response.json() as { isAdmin: boolean };
          setIsAdmin(data.isAdmin);
          if (data.isAdmin) {
            loadWhitelist();
          } else {
            setLoading(false);
            setError('You do not have admin access');
          }
        }
      } catch (err) {
        setLoading(false);
        setError('Failed to check access');
      }
    };

    checkAccess();
  }, [isAuthenticated, loadWhitelist]);

  const handleAddSingle = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddStatus(null);

    const fid = parseInt(singleFid.trim(), 10);
    if (isNaN(fid) || fid <= 0) {
      setAddStatus({ error: 'Please enter a valid FID' });
      return;
    }

    try {
      const response = await apiClient.post('/api/admin/beta-whitelist', {
        fid,
        notes: notes.trim() || undefined,
      });

      if (response.ok) {
        setAddStatus({ success: `FID ${fid} added to whitelist` });
        setSingleFid('');
        setNotes('');
        loadWhitelist();
      } else {
        const data = await response.json() as { error?: string };
        setAddStatus({ error: data.error || 'Failed to add to whitelist' });
      }
    } catch (err) {
      setAddStatus({ error: 'Failed to add to whitelist' });
    }
  };

  const handleAddBulk = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddStatus(null);

    if (!bulkFids.trim()) {
      setAddStatus({ error: 'Please enter FIDs (comma-separated)' });
      return;
    }

    try {
      const response = await apiClient.post('/api/admin/beta-whitelist', {
        fids: bulkFids.trim(),
      });

      if (response.ok) {
        const data = await response.json() as { added: number[]; failed: string[]; message: string };
        let message = data.message;
        if (data.failed.length > 0) {
          message += ` (${data.failed.length} failed: ${data.failed.join(', ')})`;
        }
        setAddStatus({ success: message });
        setBulkFids('');
        loadWhitelist();
      } else {
        const data = await response.json() as { error?: string };
        setAddStatus({ error: data.error || 'Failed to add to whitelist' });
      }
    } catch (err) {
      setAddStatus({ error: 'Failed to add to whitelist' });
    }
  };

  const handleDelete = async (fid: number) => {
    try {
      const response = await apiClient.delete(`/api/admin/beta-whitelist/${fid}`);
      if (response.ok) {
        setDeleteConfirm(null);
        loadWhitelist();
      }
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  if (!isAuthenticated) {
    return (
      <>
        <Header showBack backLabel="Back" onBack={() => navigate('/')} />
        <div className="beta-whitelist-page mobile-layout-container">
          <div className="access-denied">
            <AlertCircle size={48} />
            <h2>Sign in required</h2>
            <p>Please sign in to access this page.</p>
          </div>
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <Header showBack backLabel="Back" onBack={() => navigate('/')} />
        <div className="beta-whitelist-page mobile-layout-container">
          <div className="loading-state">Loading...</div>
        </div>
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <Header showBack backLabel="Back" onBack={() => navigate('/')} />
        <div className="beta-whitelist-page mobile-layout-container">
          <div className="access-denied">
            <AlertCircle size={48} />
            <h2>Access Denied</h2>
            <p>You don't have permission to access this page.</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header showBack backLabel="Back" onBack={() => navigate('/')} />
      <div className="beta-whitelist-page mobile-layout-container">
        <div className="page-header">
          <Users size={28} />
          <h1>Beta Whitelist</h1>
          <span className="count-badge">{total} users</span>
        </div>

        {/* Add Form */}
        <div className="add-section">
          <div className="add-mode-tabs">
            <button 
              className={`mode-tab ${addMode === 'single' ? 'active' : ''}`}
              onClick={() => setAddMode('single')}
            >
              Single
            </button>
            <button 
              className={`mode-tab ${addMode === 'bulk' ? 'active' : ''}`}
              onClick={() => setAddMode('bulk')}
            >
              Bulk
            </button>
          </div>

          {addMode === 'single' ? (
            <form onSubmit={handleAddSingle} className="add-form">
              <div className="form-row">
                <input
                  type="text"
                  placeholder="FID (e.g., 12345)"
                  value={singleFid}
                  onChange={(e) => setSingleFid(e.target.value)}
                  className="fid-input"
                />
                <input
                  type="text"
                  placeholder="Notes (optional)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="notes-input"
                />
                <button type="submit" className="add-button">
                  <Plus size={18} />
                  Add
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleAddBulk} className="add-form">
              <div className="form-row bulk">
                <textarea
                  placeholder="Enter FIDs separated by commas (e.g., 12345, 67890, 11111)"
                  value={bulkFids}
                  onChange={(e) => setBulkFids(e.target.value)}
                  className="bulk-input"
                  rows={3}
                />
              </div>
              <button type="submit" className="add-button full-width">
                <Plus size={18} />
                Add All
              </button>
            </form>
          )}

          {addStatus && (
            <div className={`add-status ${addStatus.error ? 'error' : 'success'}`}>
              {addStatus.error ? (
                <><XIcon size={16} /> {addStatus.error}</>
              ) : (
                <><Check size={16} /> {addStatus.success}</>
              )}
            </div>
          )}
        </div>

        {/* Whitelist Table */}
        <div className="whitelist-table">
          <div className="table-header">
            <span className="col-fid">FID</span>
            <span className="col-fname">Username</span>
            <span className="col-date">Added</span>
            <span className="col-actions">Actions</span>
          </div>

          {entries.length === 0 ? (
            <div className="empty-state">
              <p>No users in whitelist yet.</p>
            </div>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className="table-row">
                <span className="col-fid">{entry.fid}</span>
                <span className="col-fname">{entry.fname || '—'}</span>
                <span className="col-date">{formatDate(entry.added_at)}</span>
                <span className="col-actions">
                  {deleteConfirm === entry.fid ? (
                    <div className="confirm-actions">
                      <button 
                        className="confirm-yes"
                        onClick={() => handleDelete(entry.fid)}
                      >
                        <Check size={14} />
                      </button>
                      <button 
                        className="confirm-no"
                        onClick={() => setDeleteConfirm(null)}
                      >
                        <XIcon size={14} />
                      </button>
                    </div>
                  ) : (
                    <button 
                      className="delete-button"
                      onClick={() => setDeleteConfirm(entry.fid)}
                      title="Remove from whitelist"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
};

export default BetaWhitelistPage;

