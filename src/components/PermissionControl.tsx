import React, { useState } from 'react';
import { Globe, Lock, Ghost, Users, ChevronDown } from 'lucide-react';
import type { Audiences } from '../lib/types';
import AllowlistSelector from './AllowlistSelector';
import './PermissionControl.css';

interface PermissionControlProps {
  initialAudience: Audiences;
  onSave: (audience: Audiences, allowlistId?: string) => void;
}

const PermissionControl: React.FC<PermissionControlProps> = ({
  initialAudience,
  onSave
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [audience, setAudience] = useState<Audiences>(initialAudience);
  const [allowlistId, setAllowlistId] = useState<string | null>(null);

  const handleSave = () => {
    onSave(audience, allowlistId || undefined);
    setIsOpen(false);
  };

  const getAudienceIcon = (a: Audiences) => {
    switch (a) {
      case 'Public': return <Globe size={14} />;
      case 'Private': return <Lock size={14} />;
      case 'Anon': return <Ghost size={14} />;
      case 'Allowlist': return <Users size={14} />;
    }
  };

  return (
    <div className="permission-control">
      {!isOpen ? (
        <button className="permission-summary-btn" onClick={() => setIsOpen(true)}>
          <div className="summary-item">
            {getAudienceIcon(audience)}
            <span>{audience}</span>
          </div>
          <ChevronDown size={14} className="chevron" />
        </button>
      ) : (
        <div className="permission-editor">
          <div className="editor-section">
            <label>Who can see this?</label>
            <div className="audience-grid">
              {(['Public', 'Anon', 'Allowlist', 'Private'] as Audiences[]).map((a) => (
                <button
                  key={a}
                  className={`audience-option ${audience === a ? 'active' : ''}`}
                  onClick={() => setAudience(a)}
                >
                  {getAudienceIcon(a)}
                  <span>{a}</span>
                </button>
              ))}
            </div>

            {audience === 'Allowlist' && (
              <div className="allowlist-picker">
                <AllowlistSelector
                  selectedId={allowlistId}
                  onSelect={setAllowlistId}
                />
              </div>
            )}
          </div>

          <div className="editor-actions">
            <button className="cancel-btn" onClick={() => setIsOpen(false)}>Cancel</button>
            <button className="save-btn" onClick={handleSave}>Save Changes</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PermissionControl;
