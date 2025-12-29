import type { QueryType, ScaleConfig } from '../lib/types';

export interface ExampleQuestion {
  stem: string;
  type: QueryType;
  a_options?: string[];
  scale_config?: ScaleConfig;
}

export const exampleQuestions: ExampleQuestion[] = [
  {
    stem: "What is your favorite color?",
    type: 'mc',
    a_options: ["Red", "Blue", "Green", "Yellow", "Purple", "Orange"]
  },
  {
    stem: "How likely are you to recommend Qbase to a friend?",
    type: 'scale',
    scale_config: { min: 0, max: 10, minLabel: "Not likely", maxLabel: "Extremely likely" }
  },
  // {
  //   stem: "Have you ever traveled outside your home country?",
  //   type: 'boolean'
  // },
  // {
  //   stem: "When did you graduate high school?",
  //   type: 'date'
  // },
  {
    stem: "Describe your perfect Sunday morning.",
    type: 'text'
  }
];
