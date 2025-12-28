import { useState } from 'react';
import './TaxonomyTestPage.css';

interface TestResult {
  name: string;
  stem: string;
  options?: string[];
  result?: {
    primary_type: string;
    construction_type: string;
    content_tags: string[];
    sensitivity: string;
    temporal_markers?: string[];
    is_template: boolean;
    reasoning: string;
  };
  expected: {
    primary_type: string;
    construction_type: string;
    content_tags: string[];
    sensitivity: string;
    temporal_markers?: string[];
    is_template?: boolean;
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

export default function TaxonomyTestPage() {
  const [loading, setLoading] = useState(false);
  const [testResults, setTestResults] = useState<TestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        
        <button 
          className="run-tests-button" 
          onClick={runTests}
          disabled={loading}
        >
          {loading ? '🔄 Running Tests...' : '🧪 Run Tests'}
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
                            <span className={test.result.primary_type === test.expected.primary_type ? 'match' : 'mismatch'}>
                              {test.result.primary_type}
                            </span>
                          </div>
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

