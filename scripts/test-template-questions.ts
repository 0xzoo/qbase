import type { Ai } from '../worker-configuration';

/**
 * Test Template Question Handling
 * 
 * This module validates the universal embedding approach for template questions.
 * Can be run from a worker endpoint with real Cloudflare AI.
 */

export interface TestCase {
  q1: { stem: string; options?: string[] };
  q2: { stem: string; options?: string[] };
  expected: 'MATCH' | 'NO_MATCH';
  rationale: string;
  group: string;
}

export const testCases: TestCase[] = [
  // ============================================
  // Group 1: Regular MC Questions (Should Match)
  // ============================================
  {
    group: 'Regular MC',
    q1: { stem: "What is your favorite programming language?", options: ["JavaScript", "Python", "Java"] },
    q2: { stem: "What is your favorite programming language?", options: ["Rust", "Go", "C++"] },
    expected: 'MATCH',
    rationale: "Same core question, options are just suggestions"
  },
  {
    group: 'Regular MC',
    q1: { stem: "Which programming language do you prefer?", options: ["JS", "Python"] },
    q2: { stem: "What is your favorite programming language?", options: ["Java", "C++"] },
    expected: 'MATCH',
    rationale: "Semantically identical stems should match despite different options"
  },
  {
    group: 'Regular MC',
    q1: { stem: "What is your favorite color?", options: ["Red", "Blue", "Green"] },
    q2: { stem: "What is your favorite color?", options: [] },
    expected: 'MATCH',
    rationale: "Options shouldn't prevent matching for regular questions"
  },
  {
    group: 'Regular MC',
    q1: { stem: "How often do you exercise?", options: ["Daily", "Weekly", "Monthly", "Never"] },
    q2: { stem: "How often do you exercise?", options: ["Every day", "Once a week", "Rarely", "Not at all"] },
    expected: 'MATCH',
    rationale: "Same question with semantically similar options"
  },
  {
    group: 'Regular MC',
    q1: { stem: "What is your level of satisfaction with this product?", options: ["Very satisfied", "Satisfied", "Neutral", "Dissatisfied"] },
    q2: { stem: "How satisfied are you with this product?", options: ["Love it", "Like it", "It's okay", "Don't like it"] },
    expected: 'MATCH',
    rationale: "Similar stem, different option phrasing"
  },
  
  // ============================================
  // Group 2: Template Questions (Should NOT Match)
  // ============================================
  {
    group: 'Template',
    q1: { stem: "Would you rather", options: ["fly", "be invisible"] },
    q2: { stem: "Would you rather", options: ["have unlimited money", "have unlimited time"] },
    expected: 'NO_MATCH',
    rationale: "Different options = different questions for templates"
  },
  {
    group: 'Template',
    q1: { stem: "Would you rather", options: ["fly", "be invisible"] },
    q2: { stem: "Would you rather", options: ["have super strength", "have super speed"] },
    expected: 'NO_MATCH',
    rationale: "Even similar domains (superpowers) should create distinct questions"
  },
  {
    group: 'Template',
    q1: { stem: "Would you rather", options: ["fly", "be invisible"] },
    q2: { stem: "Choose between", options: ["fly", "be invisible"] },
    expected: 'MATCH',
    rationale: "Semantically identical template patterns with same options"
  },
  {
    group: 'Template',
    q1: { stem: "Choose between", options: ["cats", "dogs"] },
    q2: { stem: "Choose between", options: ["coffee", "tea"] },
    expected: 'NO_MATCH',
    rationale: "Same template, completely different options"
  },
  
  // ============================================
  // Group 3: Edge Cases
  // ============================================
  {
    group: 'Edge Case',
    q1: { stem: "Would you rather", options: ["fly", "be invisible"] },
    q2: { stem: "Would you rather", options: ["be invisible", "fly"] },
    expected: 'MATCH',
    rationale: "Order shouldn't matter - same question"
  },
  {
    group: 'Edge Case',
    q1: { stem: "What is your favorite color?", options: ["Red", "Blue", "Green"] },
    q2: { stem: "What is your least favorite color?", options: ["Red", "Blue", "Green"] },
    expected: 'NO_MATCH',
    rationale: "Different questions despite same options"
  },
  {
    group: 'Edge Case',
    q1: { stem: "Rank these", options: ["A", "B"] },
    q2: { stem: "Rank these", options: ["A", "B", "C", "D", "E"] },
    expected: 'NO_MATCH',
    rationale: "Different number of items in ranking"
  },
  
  // ============================================
  // Group 4: Stem-Only Questions (Should Match)
  // ============================================
  {
    group: 'Stem Only',
    q1: { stem: "What is your biggest professional challenge?", options: [] },
    q2: { stem: "What is your biggest professional challenge?", options: [] },
    expected: 'MATCH',
    rationale: "Identical open-ended questions without options"
  },
  {
    group: 'Stem Only',
    q1: { stem: "Describe your ideal work environment", options: [] },
    q2: { stem: "What does your ideal work environment look like?", options: [] },
    expected: 'MATCH',
    rationale: "Semantically similar open-ended questions"
  },
  {
    group: 'Stem Only',
    q1: { stem: "Tell me about a time you overcame a difficult obstacle", options: [] },
    q2: { stem: "Describe a challenging situation you faced", options: [] },
    expected: 'MATCH',
    rationale: "Similar interview-style questions"
  },
  
  // ============================================
  // Group 5: Distinct Questions (Should NOT Match)
  // ============================================
  {
    group: 'Distinct',
    q1: { stem: "What is your age?", options: [] },
    q2: { stem: "What is your gender?", options: [] },
    expected: 'NO_MATCH',
    rationale: "Completely different questions"
  },
  {
    group: 'Distinct',
    q1: { stem: "Do you like pizza?", options: ["Yes", "No"] },
    q2: { stem: "Do you like sushi?", options: ["Yes", "No"] },
    expected: 'NO_MATCH',
    rationale: "Similar structure, different subject"
  },
  {
    group: 'Distinct',
    q1: { stem: "How many hours do you sleep per night?", options: ["<5", "5-6", "7-8", "9+"] },
    q2: { stem: "How many hours do you work per day?", options: ["<4", "4-6", "7-8", "9+"] },
    expected: 'NO_MATCH',
    rationale: "Similar structure and options, different question"
  },
  
  // ============================================
  // Group 6: Subtle Differences (Should NOT Match)
  // ============================================
  {
    group: 'Subtle Diff',
    q1: { stem: "What is your favorite food?", options: [] },
    q2: { stem: "What is your least favorite food?", options: [] },
    expected: 'NO_MATCH',
    rationale: "Opposite questions (favorite vs least favorite)"
  },
  {
    group: 'Subtle Diff',
    q1: { stem: "How often do you exercise?", options: [] },
    q2: { stem: "How long do you exercise?", options: [] },
    expected: 'NO_MATCH',
    rationale: "Different aspects (frequency vs duration)"
  },
  {
    group: 'Subtle Diff',
    q1: { stem: "What skills do you want to learn?", options: [] },
    q2: { stem: "What skills do you already have?", options: [] },
    expected: 'NO_MATCH',
    rationale: "Different tense/context (future vs present)"
  },
  
  // ============================================
  // Group 7: Similar Options Tests
  // ============================================
  {
    group: 'Similar Options',
    q1: { stem: "What is your preferred work style?", options: ["Independent", "Collaborative", "Flexible"] },
    q2: { stem: "What is your preferred work style?", options: ["Solo", "Team-based", "Adaptable"] },
    expected: 'MATCH',
    rationale: "Same question, synonymous options"
  },
  {
    group: 'Similar Options',
    q1: { stem: "How satisfied are you?", options: ["Very", "Somewhat", "Not at all"] },
    q2: { stem: "What is your satisfaction level?", options: ["High", "Medium", "Low"] },
    expected: 'MATCH',
    rationale: "Same question, equivalent scale options"
  },
  
  // ============================================
  // Group 8: Boundary Cases
  // ============================================
  {
    group: 'Boundary',
    q1: { stem: "Pick one", options: ["A", "B"] },
    q2: { stem: "Choose one", options: ["A", "B"] },
    expected: 'MATCH',
    rationale: "Synonymous incomplete stems with same options"
  },
  {
    group: 'Boundary',
    q1: { stem: "Rate from 1 to 5", options: ["1", "2", "3", "4", "5"] },
    q2: { stem: "Rate from 1 to 10", options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] },
    expected: 'NO_MATCH',
    rationale: "Different scales are different questions"
  },
  {
    group: 'Boundary',
    q1: { stem: "Select all that apply", options: ["Option A", "Option B", "Option C"] },
    q2: { stem: "Select all that apply", options: ["Option X", "Option Y", "Option Z"] },
    expected: 'NO_MATCH',
    rationale: "Generic stem but different options should NOT match"
  },
  
  // ============================================
  // Group 9: LLM Classification Edge Cases
  // ============================================
  {
    group: 'LLM Edge Cases',
    q1: { stem: "This or that", options: ["cats", "dogs"] },
    q2: { stem: "This or that", options: ["coffee", "tea"] },
    expected: 'NO_MATCH',
    rationale: "Template pattern not in old pattern list - LLM should catch it"
  },
  {
    group: 'LLM Edge Cases',
    q1: { stem: "Love or hate", options: ["pineapple on pizza", "anchovies"] },
    q2: { stem: "Love or hate", options: ["early mornings", "late nights"] },
    expected: 'NO_MATCH',
    rationale: "Creative template pattern - LLM should detect"
  },
  {
    group: 'LLM Edge Cases',
    q1: { stem: "Choose one project to focus on this quarter", options: [] },
    q2: { stem: "Choose one project to focus on this quarter", options: [] },
    expected: 'MATCH',
    rationale: "Context makes it complete - LLM should recognize"
  },
];

// LLM-based template detection prompt
const TEMPLATE_CLASSIFICATION_PROMPT = `Classify if this question stem is "incomplete" (requires specific options to be meaningful).

INCOMPLETE stems are generic patterns that need options to form a complete question:
- "Would you rather" → needs specific choices
- "Choose between" → needs specific options
- "This or that" → needs specific items
- "Rank these" → needs specific items to rank
- "X vs Y" → needs specific X and Y

COMPLETE stems are full questions that make sense on their own:
- "What is your favorite color?" → complete question
- "How satisfied are you with your job?" → complete question
- "Would you rather work remotely or in an office?" → complete (options built-in)
- "Do you prefer cats or dogs?" → complete (options built-in)

Question stem: "{{STEM}}"
{{OPTIONS_INFO}}

Is this stem "incomplete" or "complete"?
Answer with ONLY ONE WORD: "incomplete" or "complete".`;

// LLM-based classification with fallback
export async function isIncompleteStem(
  stem: string,
  options: string[] | undefined,
  ai: Ai
): Promise<boolean> {
  const trimmedStem = stem.trim();
  
  // Fast heuristic: Very short stem with colon is almost always incomplete
  if (trimmedStem.endsWith(':') && trimmedStem.split(/\s+/).length <= 3) {
    return true;
  }
  
  try {
    const optionsInfo = options && options.length > 0
      ? `Options provided: ${options.join(', ')}`
      : 'No options provided';
    
    const prompt = TEMPLATE_CLASSIFICATION_PROMPT
      .replace('{{STEM}}', stem)
      .replace('{{OPTIONS_INFO}}', optionsInfo);
    
    const response = await ai.run('@cf/meta/llama-3-8b-instruct', {
      prompt,
      max_tokens: 10,
      temperature: 0.1, // Very low for consistency
    }) as { response?: string };
    
    const answer = (response.response || '').toLowerCase().trim();
    return answer.includes('incomplete');
    
  } catch (error) {
    console.error('LLM classification failed, using fallback heuristic', error);
    
    // Fallback: Very conservative - only detect obvious incomplete stems
    const normalized = trimmedStem.toLowerCase().replace(/[:.?!]+$/, '');
    const simplePatterns = [
      'would you rather',
      'choose between',
      'pick one',
      'select one',
      'rank these'
    ];
    
    return simplePatterns.some(pattern => normalized === pattern);
  }
}

// LLM-based approach: Selective embedding
// Only include options for incomplete/template stems
export async function generateEmbeddingText(
  stem: string,
  options: string[] | undefined,
  ai: Ai
): Promise<string> {
  // For incomplete stems (templates), options are part of the question's meaning
  const isTemplate = await isIncompleteStem(stem, options, ai);
  
  if (isTemplate && options && options.length > 0) {
    return `${stem} ${options.join(' ')}`;
  }
  
  // For regular questions, stem only (options can vary freely)
  return stem;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface TestResult {
  test: TestCase;
  similarity: number;
  actualMatch: boolean;
  expectedMatch: boolean;
  passed: boolean;
  text1: string;
  text2: string;
}

export interface TestSummary {
  passed: number;
  failed: number;
  total: number;
  passRate: number;
  byGroup: Record<string, { passed: number; failed: number; total: number; passRate: number }>;
  recommendation: 'deploy' | 'adjust' | 'fallback';
  recommendationText: string;
  results: TestResult[];
  failures: TestResult[];
}

export async function runTemplateTests(ai: Ai): Promise<TestSummary> {
  const results: TestResult[] = [];
  const byGroup: Record<string, { passed: number; failed: number; total: number; passRate: number }> = {};
  
  // Initialize group counters
  for (const test of testCases) {
    if (!byGroup[test.group]) {
      byGroup[test.group] = { passed: 0, failed: 0, total: 0, passRate: 0 };
    }
    byGroup[test.group].total++;
  }
  
  // Run each test
  for (const test of testCases) {
    // Generate embedding text with LLM-based template detection
    const text1 = await generateEmbeddingText(test.q1.stem, test.q1.options, ai);
    const text2 = await generateEmbeddingText(test.q2.stem, test.q2.options, ai);
    
    // Generate real embeddings
    const embeddingResponse1 = await ai.run('@cf/baai/bge-base-en-v1.5', {
      text: [text1]
    }) as { data: number[][] };
    
    const embeddingResponse2 = await ai.run('@cf/baai/bge-base-en-v1.5', {
      text: [text2]
    }) as { data: number[][] };
    
    const embedding1 = embeddingResponse1.data[0];
    const embedding2 = embeddingResponse2.data[0];
    
    const similarity = cosineSimilarity(embedding1, embedding2);
    const actualMatch = similarity >= 0.85;
    const expectedMatch = test.expected === 'MATCH';
    const passed = actualMatch === expectedMatch;
    
    const result: TestResult = {
      test,
      similarity,
      actualMatch,
      expectedMatch,
      passed,
      text1,
      text2
    };
    
    results.push(result);
    
    if (passed) {
      byGroup[test.group].passed++;
    } else {
      byGroup[test.group].failed++;
    }
  }
  
  // Calculate pass rates
  for (const group in byGroup) {
    byGroup[group].passRate = byGroup[group].passed / byGroup[group].total;
  }
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  const passRate = passed / total;
  
  // Determine recommendation
  let recommendation: 'deploy' | 'adjust' | 'fallback';
  let recommendationText: string;
  
  if (passRate >= 0.95) {
    recommendation = 'deploy';
    recommendationText = '✅ Universal approach works well! Deploy with confidence. Continue monitoring in production for edge cases.';
  } else if (passRate >= 0.80) {
    recommendation = 'adjust';
    recommendationText = '⚠️ Universal approach mostly works, but needs attention. Review failures and consider: adjusting threshold (try 0.80 or 0.90), adding option normalization (sorting), or testing with more examples.';
  } else {
    recommendation = 'fallback';
    recommendationText = '❌ Universal approach has significant issues. Implement Fallback Plan A (hybrid approach with pattern matching). See docs/template-questions.md for details.';
  }
  
  return {
    passed,
    failed,
    total,
    passRate,
    byGroup,
    recommendation,
    recommendationText,
    results,
    failures: results.filter(r => !r.passed)
  };
}
