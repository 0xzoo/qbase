import type { Question } from './mockQuestions';

export const exampleQuestions: Partial<Question>[] = [
  {
    text: "What is your favorite color?",
    type: 'mc',
    options: ["Red", "Blue", "Green", "Yellow", "Purple", "Orange"]
  },
  {
    text: "How likely are you to recommend Qbase to a friend?",
    type: 'scale',
    scaleConfig: { min: 0, max: 10, minLabel: "Not likely", maxLabel: "Extremely likely" }
  },
  {
    text: "Have you ever traveled outside your home country?",
    type: 'boolean'
  },
  {
    text: "When did you graduate high school?",
    type: 'date'
  },
  {
    text: "What are your height and weight?",
    type: 'tuple',
    tupleConfig: {
      fields: [
        { label: "Height (cm)", type: "number" },
        { label: "Weight (kg)", type: "number" }
      ]
    }
  },
  {
    text: "Describe your perfect Sunday morning.",
    type: 'text'
  }
];
