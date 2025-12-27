import React, { useState, useEffect } from 'react';
import { Search, Check, Users, UserPlus, Heart } from 'lucide-react';
import type { AllowlistWithMembers, AllowlistType } from '../lib/types';
import './AllowlistSelector.css';

interface AllowlistSelectorProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateNew?: () => void;
  apiBaseUrl?: string;
}

const AllowlistSelector: React.FC<AllowlistSelectorProps> = ({
  selectedId,
  onSelect,
  onCreateNew,
  apiBaseUrl = '/api'
}) => {
  const [search, setSearch] = useState('');
  const [allowlists, setAllowlists] = useState<AllowlistWithMembers[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    } catch (err: any) {
      setError(err.message);
      console.error('Error fetching allowlists:', err);
    } finally {
      setLoading(false);
    }
  };

  const getAuthToken = (): string => {
    // TODO: Get auth token from your auth context/provider
    return localStorage.getItem('authToken') || '';
  };

  const getListTypeLabel = (type: AllowlistType): string => {
    const labels: Record<AllowlistType, string> = {
      manual: 'Custom',
      my_followers: 'Followers',
      my_following: 'Following',
      mutual_followers: 'Mutuals',
      besties: 'Besties',
    };
    return labels[type];
  };

  const getListTypeIcon = (type: AllowlistType) => {
    const icons: Record<AllowlistType, React.ReactNode> = {
      manual: <Users size={12} />,
      my_followers: <UserPlus size={12} />,
      my_following: <UserPlus size={12} />,
      mutual_followers: <Users size={12} />,
      besties: <Heart size={12} />,
    };
    return icons[type];
  };

  const getMemberDisplay = (list: AllowlistWithMembers): string => {
    if (list.list_type === 'my_followers' || list.list_type === 'my_following' || list.list_type === 'mutual_followers') {
      return 'Dynamic';
    }
    return `${list.memberCount || 0} members`;
  };

  const filteredLists = allowlists.filter(list =>
    list.name.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="allowlist-selector loading">
        <div className="loading-message">Loading allowlists...</div>
      </div>
    );
  }

  return (
    <div className="allowlist-selector">
      <div className="selector-search">
        <Search size={14} className="search-icon" />
        <input
          type="text"
          placeholder="Search allowlists..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && <div className="selector-error">{error}</div>}

      <div className="selector-list">
        {onCreateNew && (
          <div
            className="selector-item create-new"
            onClick={onCreateNew}
          >
            <div className="item-info">
              <span className="item-name">+ Create New Allowlist</span>
            </div>
          </div>
        )}

        {filteredLists.map(list => (
          <div
            key={list.id}
            className={`selector-item ${selectedId === list.id ? 'selected' : ''}`}
            onClick={() => onSelect(list.id)}
          >
            <div className="item-icon">
              {getListTypeIcon(list.list_type)}
            </div>
            <div className="item-info">
              <div className="item-header">
                <span className="item-name">{list.name}</span>
                <span className="item-type">{getListTypeLabel(list.list_type)}</span>
              </div>
              <span className="item-count">{getMemberDisplay(list)}</span>
            </div>
            {selectedId === list.id && <Check size={14} className="check-icon" />}
          </div>
        ))}

        {filteredLists.length === 0 && !onCreateNew && (
          <div className="no-results">
            {search ? 'No allowlists found' : 'No allowlists created yet'}
          </div>
        )}
      </div>
    </div>
  );
};

export default AllowlistSelector;
