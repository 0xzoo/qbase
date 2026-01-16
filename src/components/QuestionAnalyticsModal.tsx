/**
 * QuestionAnalyticsModal Component
 * 
 * Full-page modal for analyzing answers to a question.
 * Displays different visualizations based on question type:
 * - MC/Checkbox: Bar chart distribution of selected options
 * - Scale: Histogram/distribution with average
 * - Text: Word frequency analysis and answer list
 * 
 * Supports filtering by source (all, qbase only, farcaster only).
 */

import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Filter, Users, MessageCircle, ChevronDown, Info } from 'lucide-react';
import type { Query, Answer, AnswerWFname } from '../lib/types';
import type { FarcasterReply } from '../hooks/useFarcasterReplies';
import './QuestionAnalyticsModal.css';

interface QuestionAnalyticsModalProps {
  isOpen: boolean;
  onClose: () => void;
  question: Query;
  answers: (Answer | AnswerWFname)[];
  farcasterReplies: FarcasterReply[];
}

type SourceFilter = 'all' | 'qbase' | 'farcaster';

// Helper to extract MC/Checkbox index from answer
function extractOptionIndex(answer: Answer | AnswerWFname): number | null {
  // Check answer_data first (structured data)
  if (answer.answer_data?.index !== undefined) {
    return answer.answer_data.index;
  }
  // Try parsing value as JSON
  try {
    const parsed = JSON.parse(answer.value);
    if (parsed.index !== undefined) return parsed.index;
  } catch {
    // Not JSON
  }
  return null;
}

// Helper to extract checkbox indices
function extractCheckboxIndices(answer: Answer | AnswerWFname): number[] {
  // Check answer_data first
  if (answer.answer_data?.indices) {
    return answer.answer_data.indices;
  }
  // Try parsing value as JSON
  try {
    const parsed = JSON.parse(answer.value);
    if (parsed.indices) return parsed.indices;
  } catch {
    // Not JSON
  }
  return [];
}

// Helper to extract scale value
function extractScaleValue(answer: Answer | AnswerWFname): number | null {
  // Check answer_data first
  if (answer.answer_data?.value !== undefined) {
    return answer.answer_data.value as number;
  }
  // Try parsing value
  const num = parseFloat(answer.value);
  if (!isNaN(num)) return num;
  // Try JSON
  try {
    const parsed = JSON.parse(answer.value);
    if (parsed.value !== undefined) return parsed.value;
  } catch {
    // Not JSON
  }
  return null;
}

// Format question type for display
function formatQuestionType(type: string): string {
  const typeMap: Record<string, string> = {
    'mc': 'Multiple Choice',
    'checkbox': 'Checkbox (Multi-select)',
    'text': 'Free Text',
    'scale': 'Scale',
    'scale_range': 'Scale Range',
  };
  return typeMap[type] || type;
}

// Helper to parse taxonomy (may be JSON string or object)
function parseTaxonomy(taxonomy: unknown): { primary_type?: string; content_tags?: string[] } | null {
  if (!taxonomy) return null;
  if (typeof taxonomy === 'string') {
    try {
      return JSON.parse(taxonomy);
    } catch {
      return null;
    }
  }
  return taxonomy as { primary_type?: string; content_tags?: string[] };
}

// Metadata Accordion Component
const MetadataAccordion: React.FC<{ question: Query }> = ({ question }) => {
  const [isOpen, setIsOpen] = useState(false);
  const taxonomy = parseTaxonomy(question.taxonomy);
  
  return (
    <div className="metadata-accordion">
      <button 
        className={`metadata-accordion-header ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="metadata-header-content">
          <Info size={16} />
          <span>Question Metadata</span>
        </div>
        <ChevronDown 
          size={18} 
          className={`accordion-chevron ${isOpen ? 'open' : ''}`}
        />
      </button>
      
      {isOpen && (
        <div className="metadata-accordion-content">
          {/* Type */}
          <div className="metadata-row">
            <span className="metadata-label">Type</span>
            <span className="metadata-value">{formatQuestionType(question.type)}</span>
          </div>
          
          {/* Primary Class */}
          {taxonomy?.primary_type && (
            <div className="metadata-row">
              <span className="metadata-label">Primary Class</span>
              <span className={`metadata-badge primary-${taxonomy.primary_type}`}>
                {taxonomy.primary_type}
              </span>
            </div>
          )}
          
          {/* Secondary Class (content_tags) */}
          {taxonomy?.content_tags && taxonomy.content_tags.length > 0 && (
            <div className="metadata-row">
              <span className="metadata-label">Secondary Class</span>
              <div className="metadata-tags">
                {taxonomy.content_tags.map((tag, idx) => (
                  <span key={idx} className="metadata-tag content-tag">{tag}</span>
                ))}
              </div>
            </div>
          )}
          
          {/* Tags */}
          {question.tags && question.tags.length > 0 && (
            <div className="metadata-row">
              <span className="metadata-label">Tags</span>
              <div className="metadata-tags">
                {question.tags.map((tag, idx) => (
                  <span key={idx} className="metadata-tag">{tag}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Bar component for charts
const Bar: React.FC<{
  label: string;
  count: number;
  percentage: number;
  maxPercentage: number;
  color?: string;
}> = ({ label, count, percentage, maxPercentage, color = '#7c65c1' }) => {
  const widthPercent = maxPercentage > 0 ? (percentage / maxPercentage) * 100 : 0;
  
  return (
    <div className="analytics-bar-row">
      <div className="analytics-bar-label">{label}</div>
      <div className="analytics-bar-container">
        <div 
          className="analytics-bar-fill"
          style={{ 
            width: `${widthPercent}%`,
            backgroundColor: color,
          }}
        />
        <span className="analytics-bar-value">
          {count} ({percentage.toFixed(1)}%)
        </span>
      </div>
    </div>
  );
};

// MC/Checkbox Analytics Component
const MCAnalytics: React.FC<{
  question: Query;
  answers: (Answer | AnswerWFname)[];
  isCheckbox?: boolean;
}> = ({ question, answers, isCheckbox = false }) => {
  const options = question.a_options || [];
  
  const distribution = useMemo(() => {
    const counts: Record<number, number> = {};
    options.forEach((_, idx) => { counts[idx] = 0; });
    
    answers.forEach(answer => {
      if (isCheckbox) {
        const indices = extractCheckboxIndices(answer);
        indices.forEach(idx => {
          if (counts[idx] !== undefined) counts[idx]++;
        });
      } else {
        const idx = extractOptionIndex(answer);
        if (idx !== null && counts[idx] !== undefined) {
          counts[idx]++;
        }
      }
    });
    
    const total = isCheckbox 
      ? Object.values(counts).reduce((a, b) => a + b, 0)
      : answers.length;
    
    return options.map((opt, idx) => ({
      label: opt,
      count: counts[idx],
      percentage: total > 0 ? (counts[idx] / total) * 100 : 0,
    }));
  }, [answers, options, isCheckbox]);
  
  const maxPercentage = Math.max(...distribution.map(d => d.percentage), 1);
  
  // Color palette for bars
  const colors = ['#7c65c1', '#9c85e1', '#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd'];
  
  return (
    <div className="analytics-mc-container">
      <div className="analytics-section-header">
        <h3>Response Distribution</h3>
        <span className="analytics-total">{answers.length} responses</span>
      </div>
      <div className="analytics-bars">
        {distribution.map((item, idx) => (
          <Bar
            key={idx}
            label={item.label}
            count={item.count}
            percentage={item.percentage}
            maxPercentage={maxPercentage}
            color={colors[idx % colors.length]}
          />
        ))}
      </div>
    </div>
  );
};

// Scale Analytics Component
const ScaleAnalytics: React.FC<{
  question: Query;
  answers: (Answer | AnswerWFname)[];
}> = ({ question, answers }) => {
  const scaleConfig = question.scale_config;
  const min = scaleConfig?.min ?? 1;
  const max = scaleConfig?.max ?? 5;
  const minLabel = scaleConfig?.minLabel || scaleConfig?.customLabels?.find(l => l.value === min)?.label || String(min);
  const maxLabel = scaleConfig?.maxLabel || scaleConfig?.customLabels?.find(l => l.value === max)?.label || String(max);
  
  const stats = useMemo(() => {
    const values: number[] = [];
    const distribution: Record<number, number> = {};
    
    // Initialize all scale values
    for (let i = min; i <= max; i++) {
      distribution[i] = 0;
    }
    
    answers.forEach(answer => {
      const val = extractScaleValue(answer);
      if (val !== null && val >= min && val <= max) {
        values.push(val);
        distribution[Math.round(val)]++;
      }
    });
    
    const average = values.length > 0 
      ? values.reduce((a, b) => a + b, 0) / values.length 
      : 0;
    
    const maxCount = Math.max(...Object.values(distribution), 1);
    
    return { values, distribution, average, maxCount, total: values.length };
  }, [answers, min, max]);
  
  return (
    <div className="analytics-scale-container">
      <div className="analytics-section-header">
        <h3>Scale Distribution</h3>
        <span className="analytics-total">{stats.total} responses</span>
      </div>
      
      {/* Average display */}
      <div className="analytics-average">
        <span className="average-label">Average</span>
        <span className="average-value">{stats.average.toFixed(2)}</span>
        <span className="average-range">out of {max}</span>
      </div>
      
      {/* Distribution histogram */}
      <div className="analytics-histogram">
        <div className="histogram-bars">
          {Array.from({ length: max - min + 1 }, (_, i) => min + i).map(val => {
            const count = stats.distribution[val];
            const heightPercent = stats.maxCount > 0 ? (count / stats.maxCount) * 100 : 0;
            return (
              <div key={val} className="histogram-bar-wrapper">
                <div 
                  className="histogram-bar"
                  style={{ height: `${heightPercent}%` }}
                  title={`${count} responses`}
                />
                <span className="histogram-label">{val}</span>
                <span className="histogram-count">{count}</span>
              </div>
            );
          })}
        </div>
        <div className="histogram-labels">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      </div>
    </div>
  );
};

// Text Analytics Component
const TextAnalytics: React.FC<{
  answers: (Answer | AnswerWFname)[];
  farcasterReplies: FarcasterReply[];
  sourceFilter: SourceFilter;
}> = ({ answers, farcasterReplies, sourceFilter }) => {
  // Calculate word frequency from visible responses
  const wordFrequency = useMemo(() => {
    const words: Record<string, number> = {};
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'is', 'it', 'that', 'this', 'was', 'are',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'i', 'you', 'he',
      'she', 'we', 'they', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
      'me', 'him', 'us', 'them', 'what', 'which', 'who', 'whom', 'whose',
      'where', 'when', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
      'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
      'own', 'same', 'so', 'than', 'too', 'very', 'just', 'as', 'if', 'then',
      'because', 'about', 'into', 'through', 'during', 'before', 'after',
      'above', 'below', 'between', 'under', 'again', 'further', 'once', ''
    ]);
    
    const processText = (text: string) => {
      const cleaned = text.toLowerCase().replace(/[^\w\s]/g, ' ');
      cleaned.split(/\s+/).forEach(word => {
        if (word.length > 2 && !stopWords.has(word)) {
          words[word] = (words[word] || 0) + 1;
        }
      });
    };
    
    if (sourceFilter !== 'farcaster') {
      answers.forEach(a => processText(a.value));
    }
    if (sourceFilter !== 'qbase') {
      farcasterReplies.forEach(r => processText(r.text));
    }
    
    return Object.entries(words)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
  }, [answers, farcasterReplies, sourceFilter]);
  
  const maxCount = wordFrequency[0]?.[1] || 1;
  
  return (
    <div className="analytics-text-container">
      <div className="analytics-section-header">
        <h3>Common Words</h3>
        <span className="analytics-total">
          {(sourceFilter !== 'farcaster' ? answers.length : 0) + 
           (sourceFilter !== 'qbase' ? farcasterReplies.length : 0)} responses
        </span>
      </div>
      
      {wordFrequency.length > 0 ? (
        <div className="word-frequency-list">
          {wordFrequency.map(([word, count]) => (
            <div key={word} className="word-frequency-item">
              <span className="word-text">{word}</span>
              <div className="word-bar-container">
                <div 
                  className="word-bar"
                  style={{ width: `${(count / maxCount) * 100}%` }}
                />
              </div>
              <span className="word-count">{count}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="analytics-empty">No text responses to analyze</div>
      )}
    </div>
  );
};

const QuestionAnalyticsModal: React.FC<QuestionAnalyticsModalProps> = ({
  isOpen,
  onClose,
  question,
  answers,
  farcasterReplies,
}) => {
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  
  // Filter answers based on source
  const filteredAnswers = useMemo(() => {
    if (sourceFilter === 'farcaster') return [];
    return answers;
  }, [answers, sourceFilter]);
  
  const filteredReplies = useMemo(() => {
    if (sourceFilter === 'qbase') return [];
    return farcasterReplies;
  }, [farcasterReplies, sourceFilter]);
  
  // Count totals for each source
  const counts = useMemo(() => ({
    qbase: answers.length,
    farcaster: farcasterReplies.length,
    all: answers.length + farcasterReplies.length,
  }), [answers, farcasterReplies]);
  
  if (!isOpen) return null;
  
  const renderAnalytics = () => {
    switch (question.type) {
      case 'mc':
        return <MCAnalytics question={question} answers={filteredAnswers} />;
      case 'checkbox':
        return <MCAnalytics question={question} answers={filteredAnswers} isCheckbox />;
      case 'scale':
      case 'scale_range':
        return <ScaleAnalytics question={question} answers={filteredAnswers} />;
      case 'text':
      default:
        return (
          <TextAnalytics 
            answers={filteredAnswers} 
            farcasterReplies={filteredReplies}
            sourceFilter={sourceFilter}
          />
        );
    }
  };
  
  return createPortal(
    <div className="analytics-modal-overlay" onClick={onClose}>
      <div className="analytics-modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="analytics-modal-header">
          <div className="analytics-header-content">
            <h2>Question Analytics</h2>
            <p className="analytics-question-stem">{question.stem}</p>
          </div>
          <button className="analytics-close-btn" onClick={onClose}>
            <X size={24} />
          </button>
        </div>
        
        {/* Metadata Accordion */}
        <MetadataAccordion question={question} />
        
        {/* Source Filter */}
        <div className="analytics-filter-section">
          <div className="analytics-filter-label">
            <Filter size={16} />
            <span>Source</span>
          </div>
          <div className="analytics-filter-buttons">
            <button 
              className={`filter-btn ${sourceFilter === 'all' ? 'active' : ''}`}
              onClick={() => setSourceFilter('all')}
            >
              <Users size={14} />
              All ({counts.all})
            </button>
            <button 
              className={`filter-btn ${sourceFilter === 'qbase' ? 'active' : ''}`}
              onClick={() => setSourceFilter('qbase')}
            >
              <span className="qbase-icon">Q</span>
              qbase ({counts.qbase})
            </button>
            <button 
              className={`filter-btn ${sourceFilter === 'farcaster' ? 'active' : ''}`}
              onClick={() => setSourceFilter('farcaster')}
            >
              <MessageCircle size={14} />
              Farcaster ({counts.farcaster})
            </button>
          </div>
        </div>
        
        {/* Private answers notice */}
        {question.priv_answers > 0 && (
          <div className="analytics-private-notice">
            <span>🔒 {question.priv_answers} private answer{question.priv_answers !== 1 ? 's' : ''} (not included in analytics)</span>
          </div>
        )}
        
        {/* Main Analytics Content */}
        <div className="analytics-modal-content">
          {counts.all === 0 ? (
            <div className="analytics-empty-state">
              <p>No responses yet to analyze.</p>
              <p className="analytics-empty-hint">Share this question to collect responses!</p>
            </div>
          ) : (
            renderAnalytics()
          )}
        </div>
        
        {/* Footer */}
        <div className="analytics-modal-footer">
          <button className="analytics-done-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default QuestionAnalyticsModal;
