// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface ParsedQuery {
  type: 'text' | 'multiple_choice' | 'scale';
  options?: string[];
  scaleLabels?: { start: string; end: string };
}

export class AIService {
  private ai: any;

  constructor(ai: any) {
    this.ai = ai;
  }

  /**
   * Detect if a question stem is "incomplete" (requires options to be meaningful)
   * Uses LLM classification with fallback heuristics
   */
  async isIncompleteStem(
    stem: string,
    options?: string[]
  ): Promise<boolean> {
    const trimmedStem = stem.trim();
    
    // Fast heuristic: Questions ending with colon are almost always incomplete
    // (colon grammatically indicates that options/items follow)
    if (trimmedStem.endsWith(':')) {
      return true;
    }
    
    try {
      const optionsInfo = options && options.length > 0
        ? `Options provided: ${options.join(', ')}`
        : 'No options provided';
      
      const prompt = `Classify if this question stem is "incomplete" (requires specific options to be meaningful).

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

Question stem: "${stem}"
${optionsInfo}

Is this stem "incomplete" or "complete"?
Answer with ONLY ONE WORD: "incomplete" or "complete".`;
      
      const response: { response?: string } = await this.ai.run('@cf/meta/llama-3-8b-instruct', {
        prompt,
        max_tokens: 10,
        temperature: 0.1, // Very low for consistency
      });
      
      const answer = response.response.toLowerCase().trim();
      return answer.includes('incomplete');
      
    } catch (error) {
      console.error('LLM classification failed', error);
      throw new Error('Unable to classify question stem. AI service temporarily unavailable. Please try again.');
    }
  }

  async parseQuery(text: string): Promise<ParsedQuery> {
    console.log('Parsing query:', text);

    const prompt = `
    You are an AI assistant that helps categorize user questions for a polling app.
    Analyze the following question and determine the best format for it.
    
    Output a JSON object with the following structure:
    {
      "type": "text" | "multiple_choice" | "scale",
      "options": ["Option 1", "Option 2"] (only for multiple_choice),
      "scaleLabels": { "start": "Label for 1", "end": "Label for 7" } (only for scale)
    }

    Rules:
    - "text": Open-ended questions.
    - "multiple_choice": Questions with distinct options (e.g., "Yes/No", "This or That", specific lists).
    - "scale": Questions asking for a rating, opinion strength, or frequency (e.g., 1-7).
    - If the question implies a binary choice (e.g., "Is...", "Do you..."), use "multiple_choice" with ["Yes", "No"].
    - If the question asks for a preference between two things, use "multiple_choice" with those two things.

    Question: "${text}"
    
    JSON Response:
    `;

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const response: { response?: string } = await this.ai.run('@cf/meta/llama-3-8b-instruct', {
          messages: [
            { role: 'system', content: 'You are a helpful assistant that outputs only valid JSON.' },
            { role: 'user', content: prompt }
          ]
        });

        console.log('AI Response:', response);

        // Attempt to parse the JSON from the response
        // Llama 3 might wrap it in markdown code blocks or have other text
        let jsonStr = response.response || '';
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }

        const result = JSON.parse(jsonStr) as ParsedQuery;

        // Validate and sanitize
        if (!['text', 'multiple_choice', 'scale'].includes(result.type)) {
          result.type = 'text';
        }

        return result;
      } catch (error) {
        attempts++;
        console.error(`Error parsing query with AI (attempt ${attempts}/${maxAttempts}):`, error);

        if (attempts >= maxAttempts) {
          return { type: 'text' };
        }

        // Wait a bit before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempts)));
      }
    }
    return { type: 'text' };
  }

  static fromEnv(env: Env): AIService {
    return new AIService(env.AI);
  }
}
