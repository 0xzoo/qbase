import { useState } from 'react';

interface TestResult {
  name: string;
  stem: string;
  options?: string[];
  result?: {
    primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge' | 'predictive' | 'invalid';
    knowledge_subtype?: 'factual' | 'problem' | 'discussion' | 'advice';
    construction_type: string;
    content_tags: string[];
    temporal_markers?: string[];
    safety_flag?: boolean;
    is_template: boolean;
    topics?: string[];
    reasoning: string;
  };
  expected: {
    primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge' | 'predictive' | 'invalid';
    knowledge_subtype?: 'factual' | 'problem' | 'discussion' | 'advice';
    construction_type: string;
    content_tags: string[];
    temporal_markers?: string[];
    safety_flag?: boolean;
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
    primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge' | 'predictive' | 'invalid';
    knowledge_subtype?: 'factual' | 'problem' | 'discussion' | 'advice';
    construction_type: string;
    content_tags: string[];
    temporal_markers?: string[];
    safety_flag?: boolean;
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

  const formatSingleResult = (result: SingleTestResult) => {
    let output = `=== CLASSIFICATION RESULT ===\n\n`;
    output += `Latency: ${result.latency.ms}ms (${result.latency.seconds}s)\n\n`;
    output += `Primary Type: ${result.result.primary_type}\n`;
    if (result.result.knowledge_subtype) {
      output += `Knowledge Subtype: ${result.result.knowledge_subtype}\n`;
    }
    output += `Construction Type: ${result.result.construction_type}\n`;
    output += `Content Tags: ${result.result.content_tags.join(', ')}\n`;
    if (result.result.topics && result.result.topics.length > 0) {
      output += `Topics: ${result.result.topics.map(t => `#${t}`).join(' ')}\n`;
    }
    if (result.result.temporal_markers && result.result.temporal_markers.length > 0) {
      output += `Temporal Markers: ${result.result.temporal_markers.join(', ')}\n`;
    }
    output += `Is Template: ${result.result.is_template ? 'Yes' : 'No'}\n`;
    if (result.result.reasoning) {
      output += `\nReasoning: ${result.result.reasoning}\n`;
    }
    return output;
  };

  const formatTestResults = (results: TestResponse) => {
    let output = `=== TEST SUMMARY ===\n\n`;
    output += `Total: ${results.summary.total}\n`;
    output += `Passed: ${results.summary.passed} ✅\n`;
    output += `Failed: ${results.summary.failed} ❌\n`;
    output += `Pass Rate: ${results.summary.passRate}%\n\n`;
    
    output += `=== TEST CASES ===\n\n`;
    
    results.results.forEach((test, index) => {
      output += `--- Test ${index + 1}: ${test.name} ${test.passed ? '✅ PASS' : '❌ FAIL'} ---\n\n`;
      output += `Question: "${test.stem}"\n`;
      if (test.options) {
        output += `Options: ${test.options.join(', ')}\n`;
      }
      output += `\n`;
      
      if (test.result) {
        output += `RESULT:\n`;
        output += `  Primary Type: ${test.result.primary_type}${test.result.primary_type === test.expected.primary_type ? ' ✅' : ' ❌'}\n`;
        if (test.result.knowledge_subtype) {
          output += `  Knowledge Subtype: ${test.result.knowledge_subtype}${test.result.knowledge_subtype === test.expected.knowledge_subtype ? ' ✅' : ' ❌'}\n`;
        }
        output += `  Construction: ${test.result.construction_type}${test.result.construction_type === test.expected.construction_type ? ' ✅' : ' ❌'}\n`;
        output += `  Tags: ${test.result.content_tags.join(', ')}\n`;
        if (test.result.topics && test.result.topics.length > 0) {
          output += `  Topics: ${test.result.topics.map(t => `#${t}`).join(' ')}\n`;
        }
        if (test.result.temporal_markers && test.result.temporal_markers.length > 0) {
          output += `  Temporal Markers: ${test.result.temporal_markers.join(', ')}\n`;
        }
        output += `  Is Template: ${test.result.is_template ? 'Yes' : 'No'}\n`;
        if (test.result.reasoning) {
          output += `  Reasoning: ${test.result.reasoning}\n`;
        }
        output += `\n`;
        
        output += `EXPECTED:\n`;
        output += `  Primary Type: ${test.expected.primary_type}\n`;
        if (test.expected.knowledge_subtype) {
          output += `  Knowledge Subtype: ${test.expected.knowledge_subtype}\n`;
        }
        output += `  Construction: ${test.expected.construction_type}\n`;
        output += `  Tags: ${test.expected.content_tags.join(', ')}\n`;
        if (test.expected.topics && test.expected.topics.length > 0) {
          output += `  Topics: ${test.expected.topics.map(t => `#${t}`).join(' ')}\n`;
        }
        if (test.expected.temporal_markers) {
          output += `  Temporal Markers: ${test.expected.temporal_markers.join(', ')}\n`;
        }
        output += `\n`;
      }
      
      if (test.errors.length > 0) {
        output += `ERRORS:\n`;
        test.errors.forEach(err => {
          output += `  - ${err}\n`;
        });
        output += `\n`;
      }
      
      output += `\n`;
    });
    
    return output;
  };

  return (
    <div style={{ fontFamily: 'monospace', padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1>Question Taxonomy Classification Tests</h1>
      <p>Test the LLM-based classifier against various question types.</p>
      
      <hr style={{ margin: '20px 0' }} />
      
      {/* Single Question Test Section */}
      <div>
        <h2>Single Question Test (with Latency)</h2>
        <p>Test a single question to measure classification accuracy and performance.</p>
        
        <div style={{ marginTop: '20px' }}>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>Question Stem:</label>
            <input
              type="text"
              value={questionStem}
              onChange={(e) => setQuestionStem(e.target.value)}
              placeholder="Enter your question..."
              style={{ width: '100%', padding: '8px', fontSize: '14px', fontFamily: 'monospace' }}
            />
          </div>
          
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>Options (comma-separated, optional):</label>
            <input
              type="text"
              value={questionOptions}
              onChange={(e) => setQuestionOptions(e.target.value)}
              placeholder="option1, option2, option3"
              style={{ width: '100%', padding: '8px', fontSize: '14px', fontFamily: 'monospace' }}
            />
          </div>
          
          <button 
            onClick={runSingleTest}
            disabled={singleLoading || !questionStem.trim()}
            style={{ padding: '10px 20px', fontSize: '14px', cursor: 'pointer' }}
          >
            {singleLoading ? 'Testing...' : 'Test Question'}
          </button>
        </div>

        {singleError && (
          <div style={{ marginTop: '20px', padding: '10px', background: '#ffebee', border: '1px solid #f44336' }}>
            <strong>Error:</strong> {singleError}
          </div>
        )}

        {singleResult && (
          <div style={{ marginTop: '20px' }}>
            <textarea
              readOnly
              value={formatSingleResult(singleResult)}
              style={{ 
                width: '100%', 
                minHeight: '300px', 
                padding: '10px', 
                fontSize: '13px', 
                fontFamily: 'monospace',
                whiteSpace: 'pre',
                overflow: 'auto'
              }}
            />
          </div>
        )}
      </div>

      <hr style={{ margin: '40px 0' }} />

      {/* Full Test Suite Section */}
      <div>
        <h2>Full Test Suite</h2>
        <p>Run all test cases to validate the classifier across different question types.</p>
        
        <button 
          onClick={runTests}
          disabled={loading}
          style={{ padding: '10px 20px', fontSize: '14px', cursor: 'pointer', marginTop: '10px' }}
        >
          {loading ? 'Running Tests...' : 'Run Full Test Suite'}
        </button>
      </div>

      {error && (
        <div style={{ marginTop: '20px', padding: '10px', background: '#ffebee', border: '1px solid #f44336' }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {testResults && (
        <div style={{ marginTop: '20px' }}>
          <textarea
            readOnly
            value={formatTestResults(testResults)}
            style={{ 
              width: '100%', 
              minHeight: '600px', 
              padding: '10px', 
              fontSize: '13px', 
              fontFamily: 'monospace',
              whiteSpace: 'pre',
              overflow: 'auto'
            }}
          />
          <p style={{ marginTop: '10px', fontSize: '13px' }}>
            Note: These tests validate the multi-dimensional question taxonomy classification system.
          </p>
        </div>
      )}
    </div>
  );
}

