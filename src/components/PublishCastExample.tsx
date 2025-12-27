/**
 * PublishCastExample Component
 * 
 * Example component demonstrating how to use Neynar signers for Farcaster actions.
 * This component allows authenticated users to publish casts to Farcaster.
 * 
 * Usage:
 * <PublishCastExample />
 */

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import './PublishCastExample.css';

export const PublishCastExample: React.FC = () => {
  const { hasSigner, activeSigner, isAuthenticated } = useAuth();
  const [castText, setCastText] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishedCast, setPublishedCast] = useState<{ hash: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePublishCast = async () => {
    if (!activeSigner) {
      setError('No active signer available');
      return;
    }

    if (!castText.trim()) {
      setError('Cast text cannot be empty');
      return;
    }

    setIsPublishing(true);
    setError(null);

    try {
      const response = await fetch('/api/farcaster/cast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          signerUuid: activeSigner.signer_uuid,
          text: castText,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to publish cast');
      }

      const result = await response.json() as { cast: { hash: string; text: string } };
      
      setPublishedCast({
        hash: result.cast.hash,
        text: result.cast.text,
      });
      
      setCastText('');
      
      // Auto-clear success message after 5 seconds
      setTimeout(() => setPublishedCast(null), 5000);
    } catch (err) {
      console.error('Error publishing cast:', err);
      setError('Failed to publish cast');
    } finally {
      setIsPublishing(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="publish-cast-container">
        <p className="info-message">Please sign in to publish casts</p>
      </div>
    );
  }

  if (!hasSigner) {
    return (
      <div className="publish-cast-container">
        <p className="info-message">
          Please create a signer to publish casts
        </p>
      </div>
    );
  }

  return (
    <div className="publish-cast-container">
      <h3>Publish to Farcaster</h3>
      
      <div className="cast-composer">
        <textarea
          value={castText}
          onChange={(e) => setCastText(e.target.value)}
          placeholder="What's on your mind?"
          maxLength={320}
          rows={4}
          disabled={isPublishing}
        />
        
        <div className="composer-footer">
          <span className="char-count">{castText.length}/320</span>
          
          <button
            onClick={handlePublishCast}
            disabled={isPublishing || !castText.trim()}
            className="publish-button"
          >
            {isPublishing ? 'Publishing...' : 'Publish Cast'}
          </button>
        </div>
      </div>

      {error && (
        <div className="error-message">
          <span>⚠️ {error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {publishedCast && (
        <div className="success-message">
          <span>✅ Cast published successfully!</span>
          <a
            href={`https://warpcast.com/~/conversations/${publishedCast.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="view-cast-link"
          >
            View on Warpcast →
          </a>
        </div>
      )}

      <div className="integration-example">
        <h4>Integration Example</h4>
        <p className="example-description">
          Here's how you can integrate Farcaster actions in your components:
        </p>
        
        <pre className="code-example">
{`import { useAuth } from '../context/AuthContext';

function MyComponent() {
  const { hasSigner, activeSigner } = useAuth();

  const publishCast = async (text: string) => {
    if (!activeSigner) return;
    
    const response = await fetch('/api/farcaster/cast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signerUuid: activeSigner.signer_uuid,
        text,
      }),
    });
    
    const result = await response.json();
    return result.cast.hash;
  };

  return (
    <button 
      onClick={() => publishCast('Hello Farcaster!')}
      disabled={!hasSigner}
    >
      Publish Cast
    </button>
  );
}`}
        </pre>
      </div>
    </div>
  );
};

export default PublishCastExample;

