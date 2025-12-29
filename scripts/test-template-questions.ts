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

// Full taxonomy classification prompt (matching AIService implementation)
const TAXONOMY_CLASSIFICATION_PROMPT = `Classify this question across multiple orthogonal dimensions:

**PRIMARY TYPE (Content/Storage - pick ONE)**:
Determines database routing - the most critical decision.

1. **IDENTITY** - Stable trait, preference, or characteristic. Answer expected to remain relatively consistent.
   - Examples: "What are your core values?", "What's your favorite movie?", "Are you religious?"
   - Storage: identity_answers (one canonical answer per user)

2. **TEMPORAL** - Designed to track change over time. Contains temporal markers.
   - Markers: "today", "right now", "currently", "this week", "recently", "at this moment"
   - Examples: "How do you feel today?", "What's your current stress level?"
   - Storage: temporal_answers (multiple answers per user, time-series)

**CONSTRUCTION TYPE (Format - pick ONE)**:
How the question is structured, independent of what it captures.

1. **COMPLETE** - Self-contained question with meaningful stem
   - Example: "What's your favorite book?" (can understand without context)

2. **TEMPLATE** - Incomplete stem requiring options to form complete question
   - Examples: "Would you rather:", "Choose between:", "Rank these:"
   - Note: Can be identity OR temporal based on content
   - "Would you rather: [rich] or [famous]" = identity + template
   - "Would you rather right now: [coffee] or [tea]" = temporal + template

3. **FOLLOW_UP** - References a previous answer, context-dependent
   - Example: "Why did you choose that?" (meaningless without parent answer)

**CONTENT TAGS (Domain - can have multiple)**:
What the question is about, independent of identity/temporal classification.

- belief (what someone thinks is true/right)
- preference (likes/dislikes, taste)
- behavioral (actions, habits, what someone DOES)
- demographic (age, location, occupation, verifiable categories)

**SENSITIVITY LEVEL (Privacy - pick ONE)**:
- low (safe, entertainment, basic preferences)
- medium (personal but not controversial)
- high (political, religious, medical, sexual, controversial)

Question: "{{STEM}}"
{{OPTIONS_INFO}}

Respond with ONLY valid JSON in this exact format:
{
  "primary_type": "identity" or "temporal",
  "construction_type": "complete" or "template" or "follow_up",
  "content_tags": ["belief", "preference", "behavioral", "demographic"],
  "sensitivity": "low" or "medium" or "high",
  "temporal_markers": ["today", "current"],
  "is_template": true or false,
  "reasoning": "Brief explanation of classification"
}`;

export interface QuestionTaxonomy {
  primary_type: 'identity' | 'temporal';
  construction_type: 'complete' | 'template' | 'follow_up';
  content_tags: Array<'belief' | 'preference' | 'behavioral' | 'demographic'>;
  sensitivity: 'low' | 'medium' | 'high';
  temporal_markers?: string[];
  is_template: boolean;
  reasoning: string;
}

// Taxonomy-based classification using full multi-dimensional approach
export async function classifyQuestion(
  stem: string,
  options: string[] | undefined,
  ai: Ai
): Promise<QuestionTaxonomy> {
  const trimmedStem = stem.trim();
  
  try {
    const optionsInfo = options && options.length > 0
      ? `Options: ${options.join(', ')}`
      : 'No options provided';
    
    const prompt = TAXONOMY_CLASSIFICATION_PROMPT
      .replace('{{STEM}}', stem)
      .replace('{{OPTIONS_INFO}}', optionsInfo);
    
    const response = await ai.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        { role: 'system', content: 'You are a helpful assistant that outputs only valid JSON.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 500,
      temperature: 0.1,
    }) as { response?: string };
    
    // Extract JSON from response
    let jsonStr = response.response || '{}';
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    
    const result = JSON.parse(jsonStr) as QuestionTaxonomy;
    
    // Validate and set defaults
    if (!['identity', 'temporal'].includes(result.primary_type)) {
      result.primary_type = 'identity';
    }
    
    if (!['complete', 'template', 'follow_up'].includes(result.construction_type)) {
      result.construction_type = 'complete';
    }
    
    if (!Array.isArray(result.content_tags)) {
      result.content_tags = ['preference'];
    }
    
    if (!['low', 'medium', 'high'].includes(result.sensitivity)) {
      result.sensitivity = 'medium';
    }
    
    // Ensure is_template matches construction_type
    result.is_template = result.construction_type === 'template';
    
    // Apply heuristics as fallback validation
    if (trimmedStem.endsWith(':')) {
      result.construction_type = 'template';
      result.is_template = true;
    }
    
    // Detect temporal markers if not already found
    const temporalMarkers = ['today', 'right now', 'currently', 'this week', 'recently', 
                             'at this moment', 'current', 'lately', 'this moment'];
    const foundMarkers = temporalMarkers.filter(marker => 
      stem.toLowerCase().includes(marker.toLowerCase())
    );
    
    if (foundMarkers.length > 0) {
      result.temporal_markers = foundMarkers;
      if (!result.reasoning.toLowerCase().includes('temporal')) {
        result.primary_type = 'temporal';
      }
    }
    
    return result;
    
  } catch (error) {
    console.error('Taxonomy classification failed, using fallback', error);
    
    // Fallback: Conservative defaults
    const isTemplate = trimmedStem.endsWith(':') || 
      ['would you rather', 'choose between', 'pick one', 'rank these']
        .some(p => trimmedStem.toLowerCase().includes(p));
    
    return {
      primary_type: 'identity',
      construction_type: isTemplate ? 'template' : 'complete',
      content_tags: ['preference'],
      sensitivity: 'low',
      is_template: isTemplate,
      reasoning: 'Fallback classification due to LLM error'
    };
  }
}

// Synchronous embedding text generation using taxonomy
export function generateEmbeddingText(
  stem: string,
  options: string[] | undefined,
  isTemplate: boolean
): string {
  // For template questions, options are part of the question's meaning
  if (isTemplate && options && options.length > 0) {
    return `${stem} ${options.join(' ')}`;
  }
  
  // For complete questions, stem only (options can vary freely)
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
    // Classify questions using full taxonomy (but we only need is_template)
    const taxonomy1 = await classifyQuestion(test.q1.stem, test.q1.options, ai);
    const taxonomy2 = await classifyQuestion(test.q2.stem, test.q2.options, ai);
    
    // Generate embedding text using taxonomy results
    const text1 = generateEmbeddingText(test.q1.stem, test.q1.options, taxonomy1.is_template);
    const text2 = generateEmbeddingText(test.q2.stem, test.q2.options, taxonomy2.is_template);
    
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
