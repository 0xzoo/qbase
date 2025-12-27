import React, { useState, useEffect } from 'react';
import { HelpCircle, CheckCircle, Wand2, Loader2, Plus, X, AlertCircle } from 'lucide-react';
import type { SimilarityCheckResponse, QuerySubmission, QueryType as TypesQueryType } from '../lib/types';

import { VectorService } from '../services/VectorService';
import { q_cost } from '../lib/consts';
import { useAuth } from '../context/AuthContext';
import { SignerSetupModal } from './SignerSetupModal';
import './CreateQueryModal.css';

interface CreateQueryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type QueryType = 'text' | 'multiple_choice' | 'scale';

interface ParsedQuery {
  type: QueryType;
  options?: string[];
  scaleLabels?: { start: string; end: string };
}

const CreateQueryModal: React.FC<CreateQueryModalProps> = ({ isOpen, onClose }) => {
  const { user, isAuthenticated, hasSigner } = useAuth();
  const [question, setQuestion] = useState('');
  const [queryType, setQueryType] = useState<QueryType>('text');
  const [showSignerModal, setShowSignerModal] = useState(false);

  // Multiple Choice State
  const [options, setOptions] = useState(['Yes', 'No']); // Default to binary-ish

  // Scale State
  const [scaleSize, setScaleSize] = useState<5 | 7>(7);
  const [scaleValue, setScaleValue] = useState<number | null>(null);
  const [scaleLabels, setScaleLabels] = useState({ start: 'Low', end: 'High' });



  const [similarityResult, setSimilarityResult] = useState<SimilarityCheckResponse | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isTyping, setIsTyping] = useState(false); // Immediate reaction
  const [isParsing, setIsParsing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [duplicateInfo, setDuplicateInfo] = useState<{ id: string; similarity: number } | null>(null);

  const MIN_LENGTH = 10;

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';

      // Reset state when closed
      setQuestion('');
      setQueryType('text');
      setOptions(['Yes', 'No']);
      setScaleSize(7);
      setScaleValue(null);
      setScaleLabels({ start: 'Low', end: 'High' });
      setSimilarityResult(null);
      setIsChecking(false);
      setIsTyping(false);
      setIsParsing(false);
      setSubmitError(null);
      setDuplicateInfo(null);
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  // Real-time similarity check using the same thresholds as server
  // - Client shows suggestions at 0.85+ (SIMILARITY_THRESHOLD)
  // - Server blocks duplicates at 0.98+ (DUPLICATE_THRESHOLD)
  // This provides early feedback while allowing similar questions
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
          const data = await VectorService.checkSimilarity(question);
          setSimilarityResult(data);
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
    }, 1000);

    return () => clearTimeout(timer);
  }, [question]);

  const handleAutofillClick = async () => {
    if (question.length < MIN_LENGTH) return;

    setIsParsing(true);
    try {
      const response = await fetch('/api/parse-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Map local queryType to API QueryType
      const apiType: TypesQueryType = queryType === 'multiple_choice' ? 'mc' : queryType === 'scale' ? 'scale' : 'text';

      // Build the submission payload
      const payload: QuerySubmission = {
        stem: question,
        type: apiType,
        coiner_id: user.fid,
        coiner_fname: user.username,
        coiner_fid: user.fid,
        cost: q_cost,
      };

      // Add type-specific fields
      if (queryType === 'multiple_choice' && options.length > 0) {
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

      const response = await fetch('/api/queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        // Try to parse as JSON first (for structured errors)
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await response.json() as {
            error?: string;
            existing_id?: string;
            similarity?: number;
          };
          
          // Handle duplicate error specially
          if (errorData.error?.includes('identical question already exists')) {
            setDuplicateInfo({
              id: errorData.existing_id!,
              similarity: errorData.similarity!
            });
            setSubmitError('This question already exists. View the existing question below.');
            return;
          }
          
          throw new Error(errorData.error || 'Failed to create query');
        }
        
        // Handle text errors
        const errorText = await response.text();
        
        // Provide helpful context based on error type
        if (response.status === 503) {
          throw new Error('Service temporarily unavailable. Please try again in a moment.');
        } else if (errorText.includes('incomplete')) {
          throw new Error('This question needs options to be complete. Please add at least 2 options above.');
        } else if (errorText.includes('at least 2 options')) {
          throw new Error('Multiple choice questions need at least 2 options.');
        } else if (errorText.includes('options cannot be empty')) {
          throw new Error('Please fill in all option fields or remove empty ones.');
        }
        
        throw new Error(errorText || 'Failed to create query');
      }

      const result = await response.json();
      console.log('Query created:', result);

      // Success! Close the modal
      onClose();
    } catch (error: unknown) {
      const err = error as { message?: string };
      console.error('Failed to create query:', error);
      setSubmitError(err.message || 'Failed to create query');
    } finally {
      setIsSubmitting(false);
    }
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
    queryType === 'multiple_choice' && options.filter(o => o.trim()).length < 2;

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
          <div className="modal-header">
            <div className="modal-title">create a new q</div>
          </div>
          <div className="question-input-container">
            <textarea
              className="question-input"
              placeholder="Ask a question..."
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
                {similarityResult?.results.map((result) => (
                  <div key={result.id} className="suggestion-item" onClick={() => console.log('Navigate to:', result.id)}>
                    <div className="suggestion-content">
                      <span className="suggestion-text">
                        {/* @ts-expect-error - metadata structure varies */}
                        {result.metadata?.text || result.metadata?.stem || `Question #${result.id.substring(0, 8)}...`}
                      </span>
                      <span className="suggestion-meta">
                        {result.score > 0.9 ? 'Exact Match' : `${Math.round(result.score * 100)}% Match`}
                      </span>
                    </div>
                    <button className="use-btn">
                      View
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Full Form - Revealed only when unique */}
          <div className={`query-form-container ${showForm ? 'visible' : ''}`}>
            <div className="form-controls-row">
              <button
                className={`autofill-btn ${isParsing ? 'parsing' : ''}`}
                onClick={handleAutofillClick}
                disabled={isParsing}
                title="Auto-detect type and options"
              >
                <Wand2 size={14} className={isParsing ? 'spin' : ''} />
                {isParsing ? 'Thinking...' : 'Autofill'}
              </button>
            </div>

            <div className="type-selector">
              {(['text', 'multiple_choice', 'scale'] as QueryType[]).map((type) => (
                <button
                  key={type}
                  className={`type-option ${queryType === type ? 'active' : ''}`}
                  onClick={() => setQueryType(type)}
                >
                  {type === 'multiple_choice' ? 'Multiple Choice' : type.charAt(0).toUpperCase() + type.slice(1)}
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
                  style={{ minHeight: '80px', resize: 'none' }}
                />
              </div>
            )}

            {queryType === 'multiple_choice' && (
              <div className="options-section">
                <div className="section-label">Responses</div>
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
            {duplicateInfo && (
              <a 
                href={`/question/${duplicateInfo.id}`}
                className="use-btn"
                style={{ 
                  alignSelf: 'flex-start',
                  textDecoration: 'none',
                  padding: '6px 12px',
                  background: '#4CAF50',
                  color: 'white',
                  borderRadius: '4px',
                  fontSize: '14px'
                }}
                onClick={onClose}
              >
                View Existing Question ({Math.round(duplicateInfo.similarity * 100)}% match)
              </a>
            )}
          </div>
          {showForm && !duplicateInfo && <span className="cost-display">cost: {q_cost}qq</span>}
          {showForm && !duplicateInfo && (
            <button
              className="submit-btn"
              onClick={handleSubmit}
              disabled={isSubmitting || !isAuthenticated}
            >
              {isSubmitting ? 'Creating...' : 'submit'}
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
