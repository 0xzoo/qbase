// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface ParsedQuery {
  type: 'text' | 'multiple_choice' | 'scale';
  options?: string[];
  scaleLabels?: { start: string; end: string };
}

export interface QuestionTaxonomy {
  primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge' | 'invalid';
  knowledge_subtype?: 'factual' | 'problem' | 'discussion' | 'advice';
  construction_type: 'complete' | 'template' | 'follow_up';
  content_tags: Array<'belief' | 'preference' | 'behavioral' | 'emotional' | 'demographic' | 'social' | 'evaluative'>;
  sensitivity: 'low' | 'medium' | 'high';
  temporal_markers?: string[];
  is_template: boolean;
  reasoning: string;
  topics: string[];
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

**FIRST: IS THIS A VALID QUESTION?**
Before classifying, check if the input is actually a question:
- If it's gibberish, random text, a greeting, a statement, a command, or anything that is NOT a genuine question seeking information or opinions → INVALID
- Examples of INVALID: "hello", "asdfasdf", "nice weather today", "do it", "🤔", single words that aren't questions
- A valid question asks for information, opinions, preferences, or seeks to understand something

**PRIMARY TYPE (Classification Decision Tree)**:
0. Is this NOT a valid question? → INVALID
1. Does this question ask about SUBJECTIVE information (feelings/beliefs/opinions/preferences/predictions)? → Continue to step 3
2. Does it ask about OBJECTIVE information (explanations/facts) that isnt about you? → KNOWLEDGE
3. Does it ask about future states/actions/plans? → PROSPECTIVE
4. Can it be asked repeatedly to track changes over time? → RECURRING
5. Otherwise → IDENTITY (stable trait or fixed memory)

**KNOWLEDGE SUBTYPE (ONLY if primary_type is "knowledge")**:
Pick ONE:
- factual: Asking for specific facts, definitions, or verifiable information
- problem: Asking for help solving a specific problem or technical issue
- advice: Asking for recommendations or guidance on what to do
- discussion: Open-ended questions seeking explanations or understanding

**CONTENT TAGS (for identity/recurring/prospective only)**:
Multiple allowed (REQUIRED - pick at least 1):
- belief (what someone thinks is true/right)
- preference (likes/dislikes, taste)
- behavioral (actions, habits, experiences)
- emotional (feelings, moods, affective states)
- demographic (age, location, occupation)
- social (relationships, interpersonal dynamics)
- evaluative (judgments/ratings of things)

**CONSTRUCTION TYPE (Format - pick ONE)**:
1. **complete**: Self-contained question, meaningful without context
2. **template**: Incomplete stem requiring options
3. **follow_up**: References previous answer, context-dependent

**TOPICS (all types)**:
Extract 1-3 general topics, lowercase:
- Examples: "programming", "rust", "sex", "europe", "donald trump", "nyc"
- Single words or 2-word phrases or names
- General categories that group similar questions

**SENSITIVITY LEVEL (Privacy - pick ONE)**:
- low (safe, entertainment, basic preferences)
- medium (personal but not controversial)
- high (political, religious, medical, sexual, controversial)

Question: "${stem}"
${optionsInfo}

Respond with ONLY valid JSON in this exact format:
{
  "primary_type": "invalid" or "knowledge" or "identity" or "recurring" or "prospective",
  "knowledge_subtype": "factual" or "problem" or "discussion" or "advice" (ONLY if primary_type is "knowledge"),
  "construction_type": "complete" or "template" or "follow_up",
  "content_tags": ["belief", "preference", etc.] (ONLY if NOT knowledge),
  "sensitivity": "low" or "medium" or "high",
  "temporal_markers": ["today", "current"] (if applicable),
  "is_template": true or false,
  "reasoning": "Brief explanation of classification",
  "topics": ["topic1"...] (max 3 topics)
}`;
      
      const response: { response?: string } = await this.ai.run('@cf/meta/llama-3.1-8b-instruct-fast', {
        messages: [
          { role: 'system', content: 'You are a helpful assistant that outputs only valid JSON.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 300,
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
      if (!['identity', 'recurring', 'prospective', 'knowledge', 'invalid'].includes(result.primary_type)) {
        result.primary_type = 'invalid'; // If AI can't classify it, treat as invalid
      }
      
      // Early return for invalid questions
      if (result.primary_type === 'invalid') {
        return {
          primary_type: 'invalid',
          construction_type: 'complete',
          content_tags: [],
          sensitivity: 'low',
          is_template: false,
          reasoning: result.reasoning || 'Input is not a valid question',
          topics: [],
        };
      }
      
      // Validate knowledge_subtype if primary_type is knowledge
      if (result.primary_type === 'knowledge') {
        if (!result.knowledge_subtype || !['factual', 'problem', 'discussion', 'advice'].includes(result.knowledge_subtype)) {
          result.knowledge_subtype = 'discussion'; // Safe default for knowledge
        }
      } else {
        // Remove knowledge_subtype if not a knowledge question
        delete result.knowledge_subtype;
      }
      
      if (!['complete', 'template', 'follow_up'].includes(result.construction_type)) {
        result.construction_type = 'complete';
      }
      
      if (!Array.isArray(result.content_tags) || result.content_tags.length === 0) {
        result.content_tags = result.primary_type === 'knowledge' ? [] : ['preference']; // Empty for knowledge, safe default for others
      }
      
      if (!['low', 'medium', 'high'].includes(result.sensitivity)) {
        result.sensitivity = 'medium'; // Safe default
      }
      
      // Validate topics array
      if (!Array.isArray(result.topics)) {
        result.topics = [];
      } else {
        // Clean and validate topics
        result.topics = result.topics
          .filter(t => typeof t === 'string' && t.trim().length > 0)
          .map(t => t.trim())
          .slice(0, 3); // Max 3 topics
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
        // Strong signal for recurring classification
        if (!result.reasoning.toLowerCase().includes('recurring')) {
          result.primary_type = 'recurring';
        }
      }
      
      return result;
      
    } catch (error) {
      console.error('Question taxonomy classification failed', error);
      throw new Error('Unable to classify question. AI service temporarily unavailable. Please try again.');
    }
  }
}
