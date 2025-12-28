// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface ParsedQuery {
  type: 'text' | 'multiple_choice' | 'scale';
  options?: string[];
  scaleLabels?: { start: string; end: string };
}

export interface QuestionTaxonomy {
  primary_type: 'identity' | 'temporal' | 'prospective';
  construction_type: 'complete' | 'template' | 'follow_up';
  content_tags: Array<'belief' | 'preference' | 'behavioral' | 'demographic'>;
  sensitivity: 'low' | 'medium' | 'high';
  temporal_markers?: string[];
  is_template: boolean;
  reasoning: string;
}

export class AIService {
  private ai: any;
  
  static fromEnv(env: Env): AIService {
    return new AIService(env.AI);
  }

  constructor(ai: any) {
    this.ai = ai;
  }

  /**
   * Classify a question across multiple orthogonal dimensions using the sociological taxonomy.
   * This is the primary classification method that should be used for all new questions.
   */
  async classifyQuestion(
    stem: string,
    options?: string[]
  ): Promise<QuestionTaxonomy> {
    try {
      const optionsInfo = options && options.length > 0
        ? `Options: ${options.join(', ')}`
        : 'No options provided';
      
      // Provide current date for temporal reasoning
      const currentDate = new Date();
      const currentYear = currentDate.getFullYear();
      const currentMonth = currentDate.toLocaleString('default', { month: 'long' });
      const dateContext = `Current date: ${currentMonth} ${currentYear}`;
      
      const prompt = `${dateContext}

Classify this question across multiple orthogonal dimensions:

**PRIMARY TYPE (Content/Storage - pick ONE)**:
Determines database routing - the most critical decision.

Ask yourself: "Would it be reasonable for someone to answer this question differently if asked at a different time?"

1. **IDENTITY** - Stable traits, preferences, or fixed memories. Answer NOT expected to change over time.
   - Present stable traits: "What are your core values?", "What's your favorite movie?"
   - Past memories (before ${currentYear}): "How did you feel during COVID?", "What were you like as a teenager?"
   - Fixed historical moments: "What was your worldview in 2016?", "How did you react to [past event]?"
   - The answer is about WHO you are or WERE, not tracking change
   - Storage: identity_answers (one canonical answer per user)

2. **TEMPORAL** - Designed to track change over time. Answer WOULD change if asked later.
   - Contains present-state markers: "today", "right now", "currently", "this week"
   - Examples: "How do you feel today?", "What's your current stress level?"
   - The question EXPECTS you to answer differently next time (that's the point)
   - Storage: temporal_answers (multiple answers per user, time-series)

3. **PROSPECTIVE** - About future plans, predictions, or intentions.
   - Ask yourself: "Is this about a specific FUTURE point or event?"
   - Fixed future references: "in 2026", "next election", "in 5 years", "after graduation"
   - Examples: "What are your goals for 2026?", "How will you vote in the next election?", "What career in 5 years?"
   - NOT floating immediacy: "later today", "tomorrow", "next week" (these are temporal)
   - The answer may change as plans evolve, but it's about a fixed future reference point
   - Storage: prospective_answers (one answer per future reference, updatable)

**CONSTRUCTION TYPE (Format - pick ONE)**:
How the question is structured, independent of what it captures.

1. **COMPLETE** - Self-contained question with meaningful stem
   - Example: "What's your favorite book?" (can understand without context)

2. **TEMPLATE** - Incomplete stem requiring options to form complete question
   - Examples: "Would you rather:", "Choose between:", "Rank these:"
   - Note: Can be identity, temporal, OR prospective based on content
   - "Would you rather: [rich] or [famous]" = identity + template
   - "Would you rather right now: [coffee] or [tea]" = temporal + template
   - "In 2026, would you rather: [move] or [stay]" = prospective + template

3. **FOLLOW_UP** - References a previous answer, context-dependent
   - Example: "Why did you choose that?" (meaningless without parent answer)

**CONTENT TAGS (Domain - can have multiple)**:
What the question is about, independent of identity/temporal/prospective classification.

- belief (what someone thinks is true/right)
- preference (likes/dislikes, taste)
- behavioral (actions, habits, what someone DOES)
- demographic (age, location, occupation, verifiable categories)

**SENSITIVITY LEVEL (Privacy - pick ONE)**:
- low (safe, entertainment, basic preferences)
- medium (personal but not controversial)
- high (political, religious, medical, sexual, controversial)

Question: "${stem}"
${optionsInfo}

**Classification Process:**
1. Is this about the FUTURE? → prospective
2. If not, would someone reasonably answer DIFFERENTLY if asked at a different time? → temporal
3. Otherwise → identity (stable trait or fixed memory)

Respond with ONLY valid JSON in this exact format:
{
  "primary_type": "identity" or "temporal" or "prospective",
  "construction_type": "complete" or "template" or "follow_up",
  "content_tags": ["belief", "preference", "behavioral", "demographic"],
  "sensitivity": "low" or "medium" or "high",
  "temporal_markers": ["today", "current"],
  "is_template": true or false,
  "reasoning": "Brief explanation of classification"
}`;
      
      const response: { response?: string } = await this.ai.run('@cf/meta/llama-3-8b-instruct', {
        messages: [
          { role: 'system', content: 'You are a helpful assistant that outputs only valid JSON.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.1, // Low for consistency
      });
      
      // Extract JSON from response
      let jsonStr = response.response || '{}';
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }
      
      const result = JSON.parse(jsonStr) as QuestionTaxonomy;
      
      // Validate and set defaults
      if (!['identity', 'temporal', 'prospective'].includes(result.primary_type)) {
        result.primary_type = 'identity'; // Default to identity
      }
      
      if (!['complete', 'template', 'follow_up'].includes(result.construction_type)) {
        result.construction_type = 'complete';
      }
      
      if (!Array.isArray(result.content_tags)) {
        result.content_tags = ['preference']; // Safe default
      }
      
      if (!['low', 'medium', 'high'].includes(result.sensitivity)) {
        result.sensitivity = 'medium'; // Safe default
      }
      
      // Ensure is_template matches construction_type
      result.is_template = result.construction_type === 'template';
      
      // Apply heuristics as fallback validation
      const trimmedStem = stem.trim();
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
        // Strong signal for temporal classification
        if (!result.reasoning.toLowerCase().includes('temporal')) {
          result.primary_type = 'temporal';
        }
      }
      
      return result;
      
    } catch (error) {
      console.error('Question taxonomy classification failed', error);
      throw new Error('Unable to classify question. AI service temporarily unavailable. Please try again.');
    }
  }
}
