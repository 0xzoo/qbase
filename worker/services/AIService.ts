// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface ParsedQuery {
  type: 'text' | 'multiple_choice' | 'scale';
  options?: string[];
  scaleLabels?: { start: string; end: string };
}

export interface QuestionTaxonomy {
  primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge' | 'predictive' | 'invalid';
  knowledge_subtype?: 'factual' | 'problem' | 'discussion' | 'advice';
  construction_type: 'complete' | 'template' | 'follow_up';
  content_tags: Array<'belief' | 'preference' | 'behavioral' | 'emotional' | 'demographic' | 'social' | 'evaluative' | 'personal_history'>;
  temporal_markers?: string[];
  safety_flag?: boolean;
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

**PRIMARY TYPE (Classification Decision Tree)**:
1. Does this question ask about **YOU (the answerer)**? → Skip to step 4
2. Does this question ask about your implicit or explicit opinions/beliefs/preferences? → IDENTITY
3. Does it ask for objective, provable facts/explanations about the world? → KNOWLEDGE
4. Does it ask about your future state/actions/plans? → PROSPECTIVE
5. Does it ask about the future state of something else (e.g. markets, weather, events)? → PREDICTIVE
6. Does it ask about your **current/temporary status** (mood, location, current activity, "right now")? → RECURRING
7. Does it ask about your past, stable traits, general preferences ("Do you like _?"), or hypothetical scenarios? → IDENTITY

Caveat: Some questions may appear to ask to be about objective facts, but actually ask for your subjective opinions/beliefs/preferences/judgments. In this case, classify the question as IDENTITY.
Example: "What's the best X?" - does the question include superlatives or comparisons to other options? If so, it should be classified as IDENTITY.
Example: "How do you rate X?" - does the question ask for a rating of X? If so, it should be classified as IDENTITY.
Example: "Is X guilty of Y?" - does the question ask for a moral or ethical judgment? If so, it should be classified as IDENTITY.

**IF PRIMARY TYPE IS "KNOWLEDGE", KNOWLEDGE SUBTYPE**:
Pick ONE:
- factual: Asking for specific facts, definitions, or verifiable information
- problem: Asking for help solving a specific problem or technical issue
- advice: Asking for guidance on what to do
- discussion: Open-ended questions seeking explanations or understanding

**IF PRIMARY TYPE IS NOT "KNOWLEDGE", CONTENT TAGS**:
Multiple allowed (REQUIRED - pick at least 1):
- belief (what someone thinks is true/right)
- preference (likes/dislikes, taste)
- behavioral (actions, habits, experiences)
- emotional (feelings, moods, affective states)
- demographic (age, location, occupation)
- social (relationships, interpersonal dynamics)
- evaluative (judgments/ratings of things)
- personal_history (past events, background)

**CONSTRUCTION TYPE (Format - pick ONE)**:
1. **complete**: Self-contained question, meaningful without context
2. **template**: Incomplete stem requiring options
3. **follow_up**: References previous answer, context-dependent

**TOPICS (all types)**:
Extract 1-3 general topics, lowercase:
- Examples: "programming", "rust", "sex", "europe", "donald trump", "nyc"
- Single words or 2 to 3-word phrases or names
- General categories that group similar questions
- **Constraint**: Do not use vague words like "life", "question", or "people". Prefer concrete entities or specific abstract concepts.

Question: "${stem}"
${optionsInfo}

Respond with ONLY valid JSON in this exact format:
{
  "primary_type": "knowledge" or "identity" or "recurring" or "prospective" or "predictive" or "invalid",
  "knowledge_subtype": "factual" or "problem" or "discussion" or "advice" (ONLY if primary_type is "knowledge"),
  "construction_type": "complete" or "template" or "follow_up",
  "content_tags": ["belief", "preference", etc.] (ONLY if NOT knowledge),
  "temporal_markers": ["today", "current", "rn"] (if applicable),
  "safety_flag": boolean (true if question contains NSFW, hate speech, or dangerous content),
  "is_template": true or false,
  "reasoning": "Brief explanation of classification",
  "topics": ["topic1"...] (max 3 topics)
}`;
      
      const response: { response?: string } = await this.ai.run('@cf/meta/llama-3.1-8b-instruct-fast', {
        messages: [
          { role: 'system', content: 'You are a question classifier assistant that outputs only valid JSON.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 300,
        temperature: 0.1, // Low for consistency
      });
      
      // Extract JSON from response
      // response.response may not be a string (Workers AI can return objects/arrays)
      let jsonStr = String(response.response || '{}');
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }
      
      const result = JSON.parse(jsonStr) as QuestionTaxonomy;
      
      // Validate and set defaults
      if (!['identity', 'recurring', 'prospective', 'knowledge', 'predictive'].includes(result.primary_type)) {
        result.primary_type = 'invalid'; // If AI can't classify it, treat as invalid
      }
      
      // Early return for invalid questions
      if (result.primary_type === 'invalid') {
        return {
          primary_type: 'invalid',
          construction_type: 'complete',
          content_tags: [],
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
      // Non-critical — return a safe default instead of blocking question creation
      return {
        primary_type: 'knowledge',
        knowledge_subtype: 'discussion',
        construction_type: 'complete',
        content_tags: [],
        temporal_markers: [],
        safety_flag: false,
        is_template: false,
        reasoning: 'Classification unavailable — defaulting to knowledge/discussion',
        topics: [],
      };
    }
  }
}
