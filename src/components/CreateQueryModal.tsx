import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { HelpCircle, CheckCircle, Wand2, Loader2, Plus, X, AlertCircle, Hash } from 'lucide-react';
import type { SimilarityCheckResponse, QuerySubmission, QueryType as TypesQueryType, FarcasterChannel } from '../lib/types';

import { VectorService } from '../services/VectorService';
import { q_cost } from '../lib/consts';
import { useAuth } from '../context/AuthContext';
import { SignerSetupModal } from './SignerSetupModal';
import CompactQuestionCard from './CompactQuestionCard';
import './CreateQueryModal.css';

interface CreateQueryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type QueryType = 'text' | 'multiple_choice' | 'checkbox' | 'scale';

interface ParsedQuery {
  type: QueryType;
  options?: string[];
  scaleLabels?: { start: string; end: string };
}

const CreateQueryModal: React.FC<CreateQueryModalProps> = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const { user, isAuthenticated, hasSigner, activeSigner, getAuthToken } = useAuth();
  const [question, setQuestion] = useState('');
  const [queryType, setQueryType] = useState<QueryType>('text');
  const [isAnon, setIsAnon] = useState(false);
  const [showSignerModal, setShowSignerModal] = useState(false);

  // Multiple Choice State
  const [options, setOptions] = useState(['Yes', 'No']); // Default to binary-ish

  // Scale State
  const [scaleSize, setScaleSize] = useState<5 | 7>(7);
  const [scaleValue, setScaleValue] = useState<number | null>(null);
  const [scaleLabels, setScaleLabels] = useState({ start: 'Low', end: 'High' });

  // Channel State
  const [selectedChannel, setSelectedChannel] = useState<FarcasterChannel | null>(null);
  const [showChannelSearch, setShowChannelSearch] = useState(false);
  const [channelSearchQuery, setChannelSearchQuery] = useState('');
  const [channelResults, setChannelResults] = useState<FarcasterChannel[]>([]);
  const [isSearchingChannels, setIsSearchingChannels] = useState(false);
  const channelSearchRef = useRef<HTMLDivElement>(null);



  const [similarityResult, setSimilarityResult] = useState<SimilarityCheckResponse | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isTyping, setIsTyping] = useState(false); // Immediate reaction
  const [isParsing, setIsParsing] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [avatarCache, setAvatarCache] = useState<Map<number, string>>(new Map());

  const MIN_LENGTH = 10;

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';

      // Reset state when closed
      setQuestion('');
      setQueryType('text');
      setIsAnon(false);
      setOptions(['Yes', 'No']);
      setScaleSize(7);
      setScaleValue(null);
      setScaleLabels({ start: 'Low', end: 'High' });
      setSimilarityResult(null);
      setIsChecking(false);
      setIsTyping(false);
      setIsParsing(false);
      setSubmitError(null);
      setSelectedChannel(null);
      setShowChannelSearch(false);
      setChannelSearchQuery('');
      setChannelResults([]);
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  // Real-time similarity check using the same thresholds as server
  // - Client shows suggestions at 0.85+ (SIMILARITY_THRESHOLD)
  // - Server blocks duplicates at 0.98+ (DUPLICATE_THRESHOLD)
  // This provides early feedback while allowing similar questions
  // Rate limit: 20 req/min, so we use 2.5s debounce to stay well under the limit
  useEffect(() => {
    if (question.length === 0) {
      setIsTyping(false);
      setIsChecking(false);
      setSimilarityResult(null);
      return;
    }

    setIsTyping(true);
    setSimilarityResult(null); // Clear previous results while typing

    const timer = setTimeout(async () => {
      setIsTyping(false);
      if (question.length >= MIN_LENGTH) {
        setIsChecking(true);
        try {
          const token = getAuthToken();
          const data = await VectorService.checkSimilarity(question, token);
          setSimilarityResult(data);
          
          // Fetch avatars for similar questions
          if (data.results && data.results.length > 0) {
            setAvatarCache(prevCache => {
              const fidsToFetch = new Set<number>();
              data.results.forEach(result => {
                // @ts-expect-error - metadata structure varies
                const fid = result.metadata?.coiner_fid;
                if (fid && !prevCache.has(fid)) {
                  fidsToFetch.add(fid);
                }
              });
              
              if (fidsToFetch.size > 0) {
                // Fetch avatars in parallel (without awaiting - update cache when ready)
                const avatarPromises = Array.from(fidsToFetch).map(async (fid) => {
                  try {
                    const response = await fetch(`/api/user/${fid}/avatar`);
                    if (response.ok) {
                      const { avatarUrl } = await response.json();
                      return { fid, avatarUrl };
                    }
                  } catch (e) {
                    console.error(`Failed to fetch avatar for FID ${fid}:`, e);
                  }
                  return { fid, avatarUrl: null };
                });
                
                Promise.all(avatarPromises).then(avatarResults => {
                  setAvatarCache(currentCache => {
                    const newCache = new Map(currentCache);
                    avatarResults.forEach(({ fid, avatarUrl }) => {
                      if (avatarUrl) {
                        newCache.set(fid, avatarUrl);
                      }
                    });
                    return newCache;
                  });
                });
              }
              
              // Return unchanged cache immediately
              return prevCache;
            });
          }
        } catch (e) {
          console.error('Similarity check failed, allowing proceed:', e);
          // Fail open - let server do final check
          setSimilarityResult({ status: 'unique', results: [] });
        } finally {
          setIsChecking(false);
        }
      } else {
        setIsChecking(false);
      }
    }, 2500); // Increased from 1000ms to 2500ms to respect 20 req/min rate limit

    return () => clearTimeout(timer);
  }, [question, getAuthToken]);

  // Channel search with debounce
  useEffect(() => {
    if (!channelSearchQuery || channelSearchQuery.length < 1) {
      setChannelResults([]);
      return;
    }

    setIsSearchingChannels(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/channels/search?q=${encodeURIComponent(channelSearchQuery)}&limit=8`);
        if (response.ok) {
          const data = await response.json();
          setChannelResults(data.channels || []);
        }
      } catch (e) {
        console.error('Channel search failed:', e);
        setChannelResults([]);
      } finally {
        setIsSearchingChannels(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [channelSearchQuery]);

  // Close channel search on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (channelSearchRef.current && !channelSearchRef.current.contains(event.target as Node)) {
        setShowChannelSearch(false);
      }
    };

    if (showChannelSearch) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showChannelSearch]);

  const handleAutofillClick = async () => {
    if (question.length < MIN_LENGTH) return;

    setIsParsing(true);
    try {
      const token = getAuthToken();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      
      const response = await fetch('/api/parse-query', {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: question })
      });

      if (response.ok) {
        const data: ParsedQuery = await response.json();
        setQueryType(data.type);
        if (data.options && data.options.length > 0) {
          setOptions(data.options);
        }
        if (data.scaleLabels) {
          setScaleLabels(data.scaleLabels);
        }
      }
    } catch (error) {
      console.error('Failed to parse query:', error);
    } finally {
      setIsParsing(false);
    }
  };

  const handleSubmit = async () => {
    if (!isAuthenticated || !user?.fid) {
      setSubmitError('You must be logged in to create queries');
      return;
    }

    // Check if user has a signer (required for Farcaster posting)
    if (!hasSigner) {
      setShowSignerModal(true);
      return;
    }

    if (question.length < MIN_LENGTH) {
      setSubmitError('Question must be at least 10 characters');
      return;
    }

    const token = getAuthToken();
    if (!token) {
      setSubmitError('Authentication token not found. Please log in again.');
      return;
    }

    console.log('[Create Query] Starting submission');
    console.log('[Create Query] Question type:', queryType);

    // Map local queryType to API QueryType
    const typeMap: Record<QueryType, TypesQueryType> = {
      'text': 'text',
      'multiple_choice': 'mc',
      'checkbox': 'checkbox',
      'scale': 'scale',
    };
    const apiType: TypesQueryType = typeMap[queryType];

    // Build the submission payload
    const payload: QuerySubmission = {
      stem: question,
      type: apiType,
      cost: q_cost,
      signerUuid: activeSigner?.signer_uuid,
      isAnon,
    };

    // Add channel if selected
    if (selectedChannel) {
      payload.channel_id = selectedChannel.id;
    }

    // Add type-specific fields
    if ((queryType === 'multiple_choice' || queryType === 'checkbox') && options.length > 0) {
      payload.a_options = options.filter(opt => opt.trim() !== '');
    } else if (queryType === 'scale') {
      payload.scale_config = {
        min: 1,
        max: scaleSize,
        step: 1,
        customLabels: [
          { value: 1, label: scaleLabels.start },
          { value: scaleSize, label: scaleLabels.end },
        ],
      };
    }

    console.log('[Create Query] Payload:', payload);

    // Fire off the request (don't await - let it complete in background)
    fetch('/api/queries', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload),
    }).then(async (response) => {
      if (response.ok) {
        const result = await response.json();
        console.log('[Create Query] Background request completed successfully:', result.id);
      } else {
        console.error('[Create Query] Background request failed:', response.status);
      }
    }).catch((error) => {
      console.error('[Create Query] Background request error:', error);
    });

    // Navigate immediately to question page with pending submission info
    // The question page will poll for the question
    onClose();
    navigate('/question/pending', {
      state: {
        pendingSubmission: {
          stem: question,
          fid: user.fid,
          token,
        }
      }
    });
  };

  if (!isOpen) return null;

  // Multiple Choice Handlers
  const handleOptionChange = (index: number, value: string) => {
    const newOptions = [...options];
    newOptions[index] = value;
    setOptions(newOptions);
  };

  const addOption = () => {
    if (options.length < 10) {
      setOptions([...options, '']);
    }
  };

  const removeOption = (index: number) => {
    if (options.length > 2) {
      const newOptions = options.filter((_, i) => i !== index);
      setOptions(newOptions);
    }
  };

  // Detect incomplete stems (simple client-side heuristic for early warning)
  // Server does full LLM-based classification on submit
  const looksLikeIncompleteStem = question.trim().endsWith(':') || 
    /^(would you rather|choose between|pick one|select one|rank these|this or that)/i.test(question.trim());
  
  const showSuggestions = !isTyping && !isChecking && similarityResult && similarityResult.results.length > 0;
  const showForm = !isTyping && !isChecking && similarityResult?.status === 'unique' && question.length >= MIN_LENGTH;
  const showWarning = !isTyping && !isChecking && question.length > 0 && question.length < MIN_LENGTH;
  const showIncompleteWarning = !isTyping && !isChecking && looksLikeIncompleteStem && 
    (queryType === 'multiple_choice' || queryType === 'checkbox') && options.filter(o => o.trim()).length < 2;

  return (
    <>
      <SignerSetupModal 
        isOpen={showSignerModal}
        onClose={() => setShowSignerModal(false)}
        action="share this question to Farcaster"
        customMessage="To create and share questions to Farcaster, you need to authorize qbase. This is a one-time setup."
      />

      <div className="create-query-modal-overlay">
        <div className="create-query-modal-container" onClick={(e) => e.stopPropagation()}>

        <div className="modal-content-wrapper">
          <div className="question-input-container">
            <textarea
              className="question-input"
              placeholder="ask anything..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              autoFocus
            />
            <div className="input-actions">
              <div className={`help-icon ${isChecking || isTyping ? 'checking' : ''} ${showSuggestions ? 'has-matches' : ''} ${showForm ? 'unique' : ''} ${showWarning ? 'warning' : ''}`}>
                {(isChecking || isTyping) && <Loader2 size={18} className="spin" />}
                {!isChecking && !isTyping && !showSuggestions && !showForm && !showWarning && <HelpCircle size={18} strokeWidth={3} />}
                {showSuggestions && <span className="match-count">{similarityResult?.results.length}</span>}
                {showForm && <CheckCircle size={18} strokeWidth={3} />}
                {showWarning && <AlertCircle size={18} strokeWidth={3} />}
              </div>
            </div>
            {showWarning && (
              <div className="input-warning-text">
                Question must be at least {MIN_LENGTH} characters
              </div>
            )}
            {showIncompleteWarning && (
              <div className="input-warning-text" style={{ color: '#ff9800' }}>
                This looks like a template question. Add at least 2 options to complete it.
              </div>
            )}
          </div>

          {/* Magic Auto-Complete Suggestions */}
          <div className={`suggestions-container ${showSuggestions ? 'visible' : ''}`}>
            {showSuggestions && (
              <div className="suggestions-list visible">
                {similarityResult?.results.map((result) => {
                  // @ts-expect-error - metadata structure varies
                  const questionText = result.metadata?.text || result.metadata?.stem || `Question #${result.id.substring(0, 8)}...`;
                  // @ts-expect-error - metadata structure varies
                  const authorName = result.metadata?.coiner_fname;
                  // @ts-expect-error - metadata structure varies
                  const authorFid = result.metadata?.coiner_fid;
                  // Get avatar from cache if available
                  const avatarUrl = authorFid ? avatarCache.get(authorFid) : undefined;
                  
                  return (
                    <CompactQuestionCard
                      key={result.id}
                      id={result.id}
                      questionText={questionText}
                      authorName={authorName}
                      authorFid={authorFid}
                      avatarUrl={avatarUrl}
                      matchScore={result.score}
                      showMatchBadge={true}
                      onClick={() => {
                        onClose();
                        navigate(`/question/${result.id}`);
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {/* Full Form - Revealed only when unique */}
          <div className={`query-form-container ${showForm ? 'visible' : ''}`}>
            
            {/* Channel Selector */}
            <div className="channel-selector-section" ref={channelSearchRef}>
              {selectedChannel ? (
                <div className="selected-channel">
                  <div className="selected-channel-info">
                    {selectedChannel.image_url && (
                      <img 
                        src={selectedChannel.image_url} 
                        alt={selectedChannel.name}
                        className="channel-image"
                      />
                    )}
                    <span className="channel-name">/{selectedChannel.id}</span>
                  </div>
                  <button 
                    className="remove-channel-btn"
                    onClick={() => setSelectedChannel(null)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <button 
                  className="add-channel-btn"
                  onClick={() => setShowChannelSearch(true)}
                >
                  <Hash size={14} />
                  <span>+ add channel</span>
                </button>
              )}
              
              {showChannelSearch && !selectedChannel && (
                <div className="channel-search-dropdown">
                  <input
                    type="text"
                    className="channel-search-input"
                    placeholder="Search channels..."
                    value={channelSearchQuery}
                    onChange={(e) => setChannelSearchQuery(e.target.value)}
                    autoFocus
                  />
                  {isSearchingChannels && (
                    <div className="channel-search-loading">
                      <Loader2 size={16} className="spin" />
                    </div>
                  )}
                  {channelResults.length > 0 && (
                    <div className="channel-results">
                      {channelResults.map((channel) => (
                        <button
                          key={channel.id}
                          className="channel-result-item"
                          onClick={() => {
                            setSelectedChannel(channel);
                            setShowChannelSearch(false);
                            setChannelSearchQuery('');
                            setChannelResults([]);
                          }}
                        >
                          {channel.image_url && (
                            <img 
                              src={channel.image_url} 
                              alt={channel.name}
                              className="channel-result-image"
                            />
                          )}
                          <div className="channel-result-info">
                            <span className="channel-result-name">/{channel.id}</span>
                            {channel.follower_count && (
                              <span className="channel-result-followers">
                                {channel.follower_count.toLocaleString()} followers
                              </span>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {channelSearchQuery && !isSearchingChannels && channelResults.length === 0 && (
                    <div className="channel-no-results">No channels found</div>
                  )}
                </div>
              )}
            </div>

            {/* Anonymous Toggle */}
            <div className={`anon-toggle-section ${isAnon ? 'active' : ''}`}>
              <label className="anon-toggle-label">
                <span className="anon-label-text">post anon</span>
                <div className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={isAnon}
                    onChange={(e) => setIsAnon(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </div>
              </label>
            </div>

            <div className="type-selector">
              {(['text', 'multiple_choice', 'checkbox', 'scale'] as QueryType[]).map((type) => (
                <button
                  key={type}
                  className={`type-option ${queryType === type ? 'active' : ''}`}
                  onClick={() => setQueryType(type)}
                >
                  {type === 'multiple_choice' ? 'Select One' : 
                   type === 'checkbox' ? 'Select Many' : 
                   type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              ))}
            </div>

            {queryType === 'text' && (
              <div className="options-section">
                <div className="section-label">Example Response</div>
                <textarea
                  className="option-input"
                  disabled
                  placeholder="Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."
                  style={{ minHeight: '130px', resize: 'none' }}
                />
              </div>
            )}

            {queryType === 'multiple_choice' && (
              <div className="options-section">
                <div className="section-label">Options (select one)</div>
                {options.map((option, index) => (
                  <div key={index} className="option-row">
                    <input
                      type="text"
                      className="option-input"
                      value={option}
                      onChange={(e) => handleOptionChange(index, e.target.value)}
                      placeholder={`Option ${index + 1}`}
                    />
                    {options.length > 2 && (
                      <button className="remove-option-btn" onClick={() => removeOption(index)}>
                        <X size={16} />
                      </button>
                    )}
                  </div>
                ))}
                {options.length < 10 && (
                  <button className="add-option-btn" onClick={addOption}>
                    <Plus size={14} /> Add Option
                  </button>
                )}
              </div>
            )}

            {queryType === 'checkbox' && (
              <div className="options-section">
                <div className="section-label">Options (select many)</div>
                {options.map((option, index) => (
                  <div key={index} className="option-row">
                    <input
                      type="text"
                      className="option-input"
                      value={option}
                      onChange={(e) => handleOptionChange(index, e.target.value)}
                      placeholder={`Option ${index + 1}`}
                    />
                    {options.length > 2 && (
                      <button className="remove-option-btn" onClick={() => removeOption(index)}>
                        <X size={16} />
                      </button>
                    )}
                  </div>
                ))}
                {options.length < 10 && (
                  <button className="add-option-btn" onClick={addOption}>
                    <Plus size={14} /> Add Option
                  </button>
                )}
              </div>
            )}

            {queryType === 'scale' && (
              <div className="options-section">
                <div className="scale-config">
                  <div className="section-label">Scale Size</div>
                  <div className="scale-size-selector">
                    <button className={`size-btn ${scaleSize === 5 ? 'active' : ''}`} onClick={() => setScaleSize(5)}>5</button>
                    <button className={`size-btn ${scaleSize === 7 ? 'active' : ''}`} onClick={() => setScaleSize(7)}>7</button>
                  </div>
                </div>

                <div className="scale-labels-config">
                  <div className="label-input-group">
                    <label>Start Label</label>
                    <input
                      type="text"
                      className="scale-label-input"
                      value={scaleLabels.start}
                      onChange={(e) => setScaleLabels({ ...scaleLabels, start: e.target.value })}
                    />
                  </div>
                  <div className="label-input-group">
                    <label>End Label</label>
                    <input
                      type="text"
                      className="scale-label-input"
                      value={scaleLabels.end}
                      onChange={(e) => setScaleLabels({ ...scaleLabels, end: e.target.value })}
                    />
                  </div>
                </div>

                <div className="section-label">Preview</div>
                <div className="scale-selector">
                  {Array.from({ length: scaleSize }, (_, i) => i + 1).map((val) => (
                    <button
                      key={val}
                      className={`scale-point ${scaleValue === val ? 'active' : ''}`}
                      onClick={() => setScaleValue(val)}
                      style={{
                        width: val === Math.ceil(scaleSize / 2) ? 40 : 32,
                        height: val === Math.ceil(scaleSize / 2) ? 40 : 32,
                        opacity: scaleValue === val ? 1 : 0.3 + (val % 4) * 0.1
                      }}
                    />
                  ))}
                </div>
                <div className="scale-labels">
                  <span>{scaleLabels.start}</span>
                  <span>{scaleLabels.end}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
            {submitError && (
              <span className="error-display" style={{ color: 'red' }}>
                {submitError}
              </span>
            )}
          </div>
          {showForm && <span className="cost-display">cost: {q_cost}qq</span>}
          {showForm && (
            <button
              className="submit-btn"
              onClick={handleSubmit}
              disabled={!isAuthenticated}
            >
              submit
            </button>
          )}
          <button className="cancel-btn" onClick={onClose}>Cancel</button>
        </div>

        </div>
      </div>
    </>
  );
};

export default CreateQueryModal;
