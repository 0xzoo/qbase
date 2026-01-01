/**
 * Test script for multi-dimensional question taxonomy classification
 * 
 * Tests the LLM-based classifier against various question types to ensure
 * it correctly identifies:
 * - Primary type (identity vs temporal)
 * - Construction type (complete vs template vs follow_up)
 * - Content tags (belief, preference, behavioral, demographic)
 * - Sensitivity level (low, medium, high)
 * 
 * Run with: npx tsx scripts/test-taxonomy-classification.ts
 */

import { AIService, QuestionTaxonomy } from '../worker/services/AIService';

// Test cases representing different taxonomic dimensions
const testCases = [
  {
    name: "Identity + Complete + Preference + Low",
    stem: "What's your favorite color?",
    options: undefined,
    expected: {
      primary_type: 'identity',
      construction_type: 'complete',
      content_tags: ['preference'],
      sensitivity: 'low',
    }
  },
  {
    name: "Temporal + Complete + Behavioral + Medium",
    stem: "How do you feel today?",
    options: undefined,
    expected: {
      primary_type: 'temporal',
      construction_type: 'complete',
      content_tags: ['behavioral'],
      sensitivity: 'medium',
      temporal_markers: ['today']
    }
  },
  {
    name: "Identity + Template + Preference + Low",
    stem: "Would you rather:",
    options: ["be rich", "be famous"],
    expected: {
      primary_type: 'identity',
      construction_type: 'template',
      content_tags: ['preference'],
      sensitivity: 'low',
      is_template: true
    }
  },
  {
    name: "Temporal + Template + Preference + Low",
    stem: "Right now, would you prefer:",
    options: ["coffee", "tea"],
    expected: {
      primary_type: 'temporal',
      construction_type: 'template',
      content_tags: ['preference'],
      sensitivity: 'low',
      is_template: true,
      temporal_markers: ['right now']
    }
  },
  {
    name: "Identity + Complete + Belief + High",
    stem: "What is your religious or spiritual orientation?",
    options: undefined,
    expected: {
      primary_type: 'identity',
      construction_type: 'complete',
      content_tags: ['belief'],
      sensitivity: 'high',
    }
  },
  {
    name: "Temporal + Complete + Behavioral + Medium",
    stem: "What's your current stress level?",
    options: undefined,
    expected: {
      primary_type: 'temporal',
      construction_type: 'complete',
      content_tags: ['behavioral'],
      sensitivity: 'medium',
      temporal_markers: ['current']
    }
  },
  {
    name: "Identity + Complete + Demographic + Medium",
    stem: "What's your education level?",
    options: undefined,
    expected: {
      primary_type: 'identity',
      construction_type: 'complete',
      content_tags: ['demographic'],
      sensitivity: 'medium',
    }
  },
  {
    name: "Identity + Complete + Belief + High",
    stem: "What's your political leaning?",
    options: undefined,
    expected: {
      primary_type: 'identity',
      construction_type: 'complete',
      content_tags: ['belief'],
      sensitivity: 'high',
    }
  },
  {
    name: "Temporal + Complete + Behavioral + Medium",
    stem: "How much did you exercise this week?",
    options: undefined,
    expected: {
      primary_type: 'temporal',
      construction_type: 'complete',
      content_tags: ['behavioral'],
      sensitivity: 'medium',
      temporal_markers: ['this week']
    }
  },
  {
    name: "Identity + Template + Preference + Low (colon detection)",
    stem: "This or that:",
    options: ["cats", "dogs"],
    expected: {
      primary_type: 'identity',
      construction_type: 'template',
      content_tags: ['preference'],
      sensitivity: 'low',
      is_template: true
    }
  },
  {
    name: "Identity + Complete + Belief + High (Trump question)",
    stem: "What do you think about Trump's economic policies?",
    options: undefined,
    expected: {
      primary_type: 'identity',
      construction_type: 'complete',
      content_tags: ['belief'],
      sensitivity: 'high',
      topics: ['politics', 'economics', 'trump']
    }
  },
  {
    name: "Identity + Complete + Preference + Low (Movie question)",
    stem: "Did you like the movie Inception?",
    options: undefined,
    expected: {
      primary_type: 'identity',
      construction_type: 'complete',
      content_tags: ['preference'],
      sensitivity: 'low',
      topics: ['movies', 'entertainment', 'film']
    }
  },
  {
    name: "Identity + Complete + Preference + Low (Dumb question)",
    stem: "If you could be any kitchen appliance, what would you be?",
    options: undefined,
    expected: {
      primary_type: 'identity',
      construction_type: 'complete',
      content_tags: ['preference'],
      sensitivity: 'low',
      topics: ['hypothetical', 'humor']
    }
  }
];

interface TestResult {
  name: string;
  passed: boolean;
  result?: QuestionTaxonomy;
  errors: string[];
}

function validateResult(result: QuestionTaxonomy, expected: any): string[] {
  const errors: string[] = [];
  
  if (result.primary_type !== expected.primary_type) {
    errors.push(`primary_type: expected ${expected.primary_type}, got ${result.primary_type}`);
  }
  
  if (result.construction_type !== expected.construction_type) {
    errors.push(`construction_type: expected ${expected.construction_type}, got ${result.construction_type}`);
  }
  
  if (result.sensitivity !== expected.sensitivity) {
    errors.push(`sensitivity: expected ${expected.sensitivity}, got ${result.sensitivity}`);
  }
  
  // Check content_tags (at least one expected tag should be present)
  const hasExpectedTag = expected.content_tags.some((tag: string) => 
    result.content_tags.includes(tag as any)
  );
  if (!hasExpectedTag) {
    errors.push(`content_tags: expected one of [${expected.content_tags.join(', ')}], got [${result.content_tags.join(', ')}]`);
  }
  
  // Check is_template if specified
  if (expected.is_template !== undefined && result.is_template !== expected.is_template) {
    errors.push(`is_template: expected ${expected.is_template}, got ${result.is_template}`);
  }
  
  // Check temporal_markers if specified
  if (expected.temporal_markers) {
    if (!result.temporal_markers || result.temporal_markers.length === 0) {
      errors.push(`temporal_markers: expected markers, got none`);
    }
  }
  
  return errors;
}

async function runTests() {
  console.log('🧪 Testing Multi-Dimensional Question Taxonomy Classifier\n');
  console.log('=' .repeat(80));
  
  // Mock environment with AI binding
  const mockEnv = {
    AI: {
      run: async (model: string, params: any) => {
        console.log(`\n[Mock AI] Model: ${model}`);
        console.log(`[Mock AI] Note: This is a mock - replace with real Cloudflare AI binding for actual tests`);
        
        // Return mock responses for testing structure
        // In real tests, this would connect to Cloudflare Workers AI
        return {
          response: JSON.stringify({
            primary_type: 'identity',
            construction_type: 'complete',
            content_tags: ['preference'],
            sensitivity: 'low',
            temporal_markers: [],
            is_template: false,
            reasoning: 'Mock classification for testing'
          })
        };
      }
    }
  };
  
  const aiService = AIService.fromEnv(mockEnv);
  const results: TestResult[] = [];
  
  for (const testCase of testCases) {
    console.log(`\n📝 Testing: ${testCase.name}`);
    console.log(`   Stem: "${testCase.stem}"`);
    if (testCase.options) {
      console.log(`   Options: [${testCase.options.join(', ')}]`);
    }
    
    try {
      const result = await aiService.classifyQuestion(testCase.stem, testCase.options);
      
      console.log(`   Result:`);
      console.log(`   - Primary: ${result.primary_type}`);
      console.log(`   - Construction: ${result.construction_type}`);
      console.log(`   - Tags: [${result.content_tags.join(', ')}]`);
      console.log(`   - Sensitivity: ${result.sensitivity}`);
      if (result.temporal_markers && result.temporal_markers.length > 0) {
        console.log(`   - Temporal markers: [${result.temporal_markers.join(', ')}]`);
      }
      console.log(`   - Reasoning: ${result.reasoning}`);
      
      const errors = validateResult(result, testCase.expected);
      
      const testResult: TestResult = {
        name: testCase.name,
        passed: errors.length === 0,
        result,
        errors
      };
      
      results.push(testResult);
      
      if (errors.length === 0) {
        console.log(`   ✅ PASSED`);
      } else {
        console.log(`   ❌ FAILED`);
        errors.forEach(error => console.log(`      - ${error}`));
      }
      
    } catch (error) {
      console.log(`   ❌ ERROR: ${error}`);
      results.push({
        name: testCase.name,
        passed: false,
        errors: [String(error)]
      });
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('\n📊 Test Summary\n');
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${passed} ✅`);
  console.log(`Failed: ${failed} ❌`);
  
  if (failed > 0) {
    console.log('\n❌ Failed Tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`\n  ${r.name}`);
      r.errors.forEach(error => console.log(`    - ${error}`));
    });
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('\n💡 Note: This test uses a mock AI service.');
  console.log('To test with real Cloudflare Workers AI:');
  console.log('1. Deploy to Cloudflare Workers');
  console.log('2. Use wrangler dev or production environment');
  console.log('3. Replace mockEnv with actual env binding\n');
  
  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  console.error('Test suite failed:', error);
  process.exit(1);
});

