import { useState } from 'react';
import './TaxonomyTestPage.css';

interface TestResult {
  name: string;
  stem: string;
  options?: string[];
  result?: {
    primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge';
    knowledge_subtype?: 'factual' | 'problem' | 'discussion' | 'advice';
    construction_type: string;
    content_tags: string[];
    sensitivity: string;
    temporal_markers?: string[];
    is_template: boolean;
    topics?: string[];
    reasoning: string;
  };
  expected: {
    primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge';
    knowledge_subtype?: 'factual' | 'problem' | 'discussion' | 'advice';
    construction_type: string;
    content_tags: string[];
    sensitivity: string;
    temporal_markers?: string[];
    is_template?: boolean;
    topics?: string[];
  };
  passed: boolean;
  errors: string[];
}

interface TestResponse {
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: string;
  };
  results: TestResult[];
}

interface SingleTestResult {
  result: {
    primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge';
    knowledge_subtype?: 'factual' | 'problem' | 'discussion' | 'advice';
    construction_type: string;
    content_tags: string[];
    sensitivity: string;
    temporal_markers?: string[];
    is_template: boolean;
    topics?: string[];
    reasoning: string;
  };
  latency: {
    ms: number;
    seconds: string;
  };
}

export default function TaxonomyTestPage() {
  const [loading, setLoading] = useState(false);
  const [testResults, setTestResults] = useState<TestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Single test state
  const [singleLoading, setSingleLoading] = useState(false);
  const [singleResult, setSingleResult] = useState<SingleTestResult | null>(null);
  const [singleError, setSingleError] = useState<string | null>(null);
  const [questionStem, setQuestionStem] = useState<string>('What\'s the best way to learn Rust?');
  const [questionOptions, setQuestionOptions] = useState<string>('');

  const runTests = async () => {
    setLoading(true);
    setError(null);
    setTestResults(null);

    try {
      const response = await fetch('/api/test/taxonomy-classification', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to run tests: ${response.statusText}`);
      }

      const data: TestResponse = await response.json();
      setTestResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setLoading(false);
    }
  };

  const runSingleTest = async () => {
    setSingleLoading(true);
    setSingleError(null);
    setSingleResult(null);

    try {
      const options = questionOptions.trim() 
        ? questionOptions.split(',').map(o => o.trim()).filter(o => o.length > 0)
        : undefined;

      const response = await fetch('/api/test/taxonomy-classification/single', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          stem: questionStem,
          options
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Failed to classify: ${response.statusText}`);
      }

      const data: SingleTestResult = await response.json();
      setSingleResult(data);
    } catch (err) {
      setSingleError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setSingleLoading(false);
    }
  };

  const getStatusIcon = (passed: boolean) => {
    return passed ? '✅' : '❌';
  };

  const getStatusClass = (passed: boolean) => {
    return passed ? 'test-passed' : 'test-failed';
  };

  return (
    <div className="taxonomy-test-page">
      <div className="test-header">
        <h1>Question Taxonomy Classification Tests</h1>
        <p className="test-description">
          Test the LLM-based classifier against various question types to ensure correct identification
          of primary type, construction type, content tags, and sensitivity level.
        </p>
      </div>

      {/* Single Question Test Section */}
      <div className="single-test-section">
        <h2>⚡ Single Question Test (with Latency)</h2>
        <p className="section-description">
          Test a single question to measure classification accuracy and performance.
        </p>
        
        <div className="single-test-form">
          <div className="form-group">
            <label htmlFor="question-stem">Question Stem:</label>
            <input
              id="question-stem"
              type="text"
              value={questionStem}
              onChange={(e) => setQuestionStem(e.target.value)}
              placeholder="Enter your question..."
              className="question-input"
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="question-options">Options (comma-separated, optional):</label>
            <input
              id="question-options"
              type="text"
              value={questionOptions}
              onChange={(e) => setQuestionOptions(e.target.value)}
              placeholder="option1, option2, option3"
              className="question-input"
            />
          </div>
          
          <button 
            className="test-button single-test-button" 
            onClick={runSingleTest}
            disabled={singleLoading || !questionStem.trim()}
          >
            {singleLoading ? '⏱️ Testing...' : '⚡ Test Question'}
          </button>
        </div>

        {singleError && (
          <div className="error-message">
            <strong>Error:</strong> {singleError}
          </div>
        )}

        {singleResult && (
          <div className="single-test-result">
            <div className="latency-badge">
              <span className="latency-label">⏱️ Latency:</span>
              <span className="latency-value">{singleResult.latency.ms}ms</span>
              <span className="latency-seconds">({singleResult.latency.seconds}s)</span>
            </div>
            
            <div className="classification-result">
              <h3>Classification Result:</h3>
              <div className="result-grid">
                <div className="result-item">
                  <span className="result-label">Primary Type:</span>
                  <span className="result-value primary-type">{singleResult.result.primary_type}</span>
                </div>
                {singleResult.result.knowledge_subtype && (
                  <div className="result-item">
                    <span className="result-label">Knowledge Subtype:</span>
                    <span className="result-value knowledge-subtype">{singleResult.result.knowledge_subtype}</span>
                  </div>
                )}
                <div className="result-item">
                  <span className="result-label">Construction:</span>
                  <span className="result-value">{singleResult.result.construction_type}</span>
                </div>
                <div className="result-item">
                  <span className="result-label">Sensitivity:</span>
                  <span className="result-value">{singleResult.result.sensitivity}</span>
                </div>
                <div className="result-item">
                  <span className="result-label">Tags:</span>
                  <span className="result-value">{singleResult.result.content_tags.join(', ')}</span>
                </div>
                {singleResult.result.topics && singleResult.result.topics.length > 0 && (
                  <div className="result-item topics-item">
                    <span className="result-label">Topics:</span>
                    <span className="result-value topics-value">
                      {singleResult.result.topics.map((topic, idx) => (
                        <span key={idx} className="topic-badge">#{topic}</span>
                      ))}
                    </span>
                  </div>
                )}
                {singleResult.result.temporal_markers && singleResult.result.temporal_markers.length > 0 && (
                  <div className="result-item">
                    <span className="result-label">Temporal Markers:</span>
                    <span className="result-value">{singleResult.result.temporal_markers.join(', ')}</span>
                  </div>
                )}
                <div className="result-item">
                  <span className="result-label">Is Template:</span>
                  <span className="result-value">{singleResult.result.is_template ? 'Yes' : 'No'}</span>
                </div>
              </div>
              {singleResult.result.reasoning && (
                <div className="reasoning">
                  <strong>Reasoning:</strong> {singleResult.result.reasoning}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="section-divider"></div>

      {/* Full Test Suite Section */}
      <div className="full-test-section">
        <h2>🧪 Full Test Suite</h2>
        <p className="section-description">
          Run all 10 test cases to validate the classifier across different question types.
        </p>
        
        <button 
          className="test-button full-test-button" 
          onClick={runTests}
          disabled={loading}
        >
          {loading ? '🔄 Running Tests...' : '🧪 Run Full Test Suite'}
        </button>
      </div>

      {error && (
        <div className="error-message">
          <strong>Error:</strong> {error}
        </div>
      )}

      {testResults && (
        <div className="test-results">
          <div className="test-summary">
            <h2>📊 Test Summary</h2>
            <div className="summary-stats">
              <div className="stat">
                <span className="stat-label">Total:</span>
                <span className="stat-value">{testResults.summary.total}</span>
              </div>
              <div className="stat passed">
                <span className="stat-label">Passed:</span>
                <span className="stat-value">{testResults.summary.passed} ✅</span>
              </div>
              <div className="stat failed">
                <span className="stat-label">Failed:</span>
                <span className="stat-value">{testResults.summary.failed} ❌</span>
              </div>
              <div className="stat pass-rate">
                <span className="stat-label">Pass Rate:</span>
                <span className="stat-value">{testResults.summary.passRate}%</span>
              </div>
            </div>
          </div>

          <div className="test-cases">
            <h2>Test Cases</h2>
            {testResults.results.map((test, index) => (
              <div key={index} className={`test-case ${getStatusClass(test.passed)}`}>
                <div className="test-case-header">
                  <span className="test-status">{getStatusIcon(test.passed)}</span>
                  <h3>{test.name}</h3>
                </div>

                <div className="test-case-body">
                  <div className="test-question">
                    <strong>Question:</strong> "{test.stem}"
                    {test.options && (
                      <div className="test-options">
                        <strong>Options:</strong> {test.options.join(', ')}
                      </div>
                    )}
                  </div>

                  {test.result && (
                    <>
                      <div className="test-result-section">
                        <h4>Classification Result:</h4>
                        <div className="result-grid">
                          <div className="result-item">
                            <span className="result-label">Primary Type:</span>
                            <span className={test.result.primary_type === test.expected.primary_type ? 'match primary-type' : 'mismatch'}>
                              {test.result.primary_type}
                            </span>
                          </div>
                          {test.result.knowledge_subtype && (
                            <div className="result-item">
                              <span className="result-label">Knowledge Subtype:</span>
                              <span className={test.result.knowledge_subtype === test.expected.knowledge_subtype ? 'match knowledge-subtype' : 'mismatch'}>
                                {test.result.knowledge_subtype}
                              </span>
                            </div>
                          )}
                          <div className="result-item">
                            <span className="result-label">Construction:</span>
                            <span className={test.result.construction_type === test.expected.construction_type ? 'match' : 'mismatch'}>
                              {test.result.construction_type}
                            </span>
                          </div>
                          <div className="result-item">
                            <span className="result-label">Sensitivity:</span>
                            <span className={test.result.sensitivity === test.expected.sensitivity ? 'match' : 'mismatch'}>
                              {test.result.sensitivity}
                            </span>
                          </div>
                          <div className="result-item">
                            <span className="result-label">Tags:</span>
                            <span>{test.result.content_tags.join(', ')}</span>
                          </div>
                          {test.result.topics && test.result.topics.length > 0 && (
                            <div className="result-item topics-item">
                              <span className="result-label">Topics:</span>
                              <span className="topics-value">
                                {test.result.topics.map((topic, idx) => (
                                  <span key={idx} className="topic-badge">#{topic}</span>
                                ))}
                              </span>
                            </div>
                          )}
                          {test.result.temporal_markers && test.result.temporal_markers.length > 0 && (
                            <div className="result-item">
                              <span className="result-label">Temporal Markers:</span>
                              <span>{test.result.temporal_markers.join(', ')}</span>
                            </div>
                          )}
                          <div className="result-item">
                            <span className="result-label">Is Template:</span>
                            <span>{test.result.is_template ? 'Yes' : 'No'}</span>
                          </div>
                        </div>
                        {test.result.reasoning && (
                          <div className="reasoning">
                            <strong>Reasoning:</strong> {test.result.reasoning}
                          </div>
                        )}
                      </div>

                      <div className="test-expected-section">
                        <h4>Expected:</h4>
                        <div className="result-grid">
                          <div className="result-item">
                            <span className="result-label">Primary Type:</span>
                            <span>{test.expected.primary_type}</span>
                          </div>
                          {test.expected.knowledge_subtype && (
                            <div className="result-item">
                              <span className="result-label">Knowledge Subtype:</span>
                              <span>{test.expected.knowledge_subtype}</span>
                            </div>
                          )}
                          <div className="result-item">
                            <span className="result-label">Construction:</span>
                            <span>{test.expected.construction_type}</span>
                          </div>
                          <div className="result-item">
                            <span className="result-label">Sensitivity:</span>
                            <span>{test.expected.sensitivity}</span>
                          </div>
                          <div className="result-item">
                            <span className="result-label">Tags:</span>
                            <span>{test.expected.content_tags.join(', ')}</span>
                          </div>
                          {test.expected.topics && test.expected.topics.length > 0 && (
                            <div className="result-item topics-item">
                              <span className="result-label">Topics:</span>
                              <span className="topics-value">
                                {test.expected.topics.map((topic, idx) => (
                                  <span key={idx} className="topic-badge">#{topic}</span>
                                ))}
                              </span>
                            </div>
                          )}
                          {test.expected.temporal_markers && (
                            <div className="result-item">
                              <span className="result-label">Temporal Markers:</span>
                              <span>{test.expected.temporal_markers.join(', ')}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {test.errors.length > 0 && (
                    <div className="test-errors">
                      <h4>Errors:</h4>
                      <ul>
                        {test.errors.map((error, i) => (
                          <li key={i}>{error}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="test-footer">
            <p>
              💡 <strong>Note:</strong> These tests validate the multi-dimensional question taxonomy
              classification system that determines how questions are stored and processed in the database.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

