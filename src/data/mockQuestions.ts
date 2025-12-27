export interface Question {
  id: number;
  text: string;
  type?: 'text' | 'mc' | 'scale' | 'boolean' | 'date' | 'tuple';
  options?: string[];
  scaleConfig?: {
    min: number;
    max: number;
    minLabel?: string;
    maxLabel?: string;
  };
  tupleConfig?: {
    fields: { label: string; type: 'text' | 'number' }[];
  };
  comments: number;
  shares: number;
  likes: number;
  author: {
    name: string;
    avatarSeed: string;
  };
}

export const mockQuestions: Question[] = [
  {
    id: 1,
    text: "how would you describe your everyday diet?",
    type: 'text',
    comments: 0,
    shares: 0,
    likes: 7,
    author: { name: "alice", avatarSeed: "alice" }
  },
  {
    id: 2,
    text: "how many times have you fallen in love?",
    type: 'text', // Could be number, but text for now
    comments: 0,
    shares: 0,
    likes: 15,
    author: { name: "bob", avatarSeed: "bob" }
  },
  {
    id: 3,
    text: "Do you believe in aliens?",
    type: 'boolean',
    comments: 5,
    shares: 2,
    likes: 23,
    author: { name: "charlie", avatarSeed: "charlie" }
  },
  {
    id: 4,
    text: "What is your favorite season?",
    type: 'mc',
    options: ["Spring", "Summer", "Autumn", "Winter"],
    comments: 12,
    shares: 4,
    likes: 31,
    author: { name: "diana", avatarSeed: "diana" }
  },
  {
    id: 5,
    text: "Rate your current stress level",
    type: 'scale',
    scaleConfig: { min: 1, max: 10, minLabel: "Zen", maxLabel: "Panic" },
    comments: 8,
    shares: 1,
    likes: 18,
    author: { name: "eve", avatarSeed: "eve" }
  },
  {
    id: 6,
    text: "When is your birthday?",
    type: 'date',
    comments: 2,
    shares: 0,
    likes: 4,
    author: { name: "frank", avatarSeed: "frank" }
  },
  {
    id: 7,
    text: "What are your coordinates?",
    type: 'tuple',
    tupleConfig: {
      fields: [
        { label: "Latitude", type: "number" },
        { label: "Longitude", type: "number" }
      ]
    },
    comments: 0,
    shares: 0,
    likes: 2,
    author: { name: "grace", avatarSeed: "grace" }
  }
];

export const mockPopularQuestions: Question[] = [
  {
    id: 101,
    text: "what is the meaning of life?",
    type: 'text',
    comments: 42,
    shares: 10,
    likes: 127,
    author: { name: "henry", avatarSeed: "henry" }
  },
  {
    id: 102,
    text: "cats or dogs?",
    type: 'mc',
    options: ["Cats", "Dogs", "Both", "Neither"],
    comments: 156,
    shares: 23,
    likes: 342,
    author: { name: "iris", avatarSeed: "iris" }
  },
  {
    id: 103,
    text: "pineapple on pizza?",
    type: 'boolean',
    comments: 89,
    shares: 45,
    likes: 256,
    author: { name: "jack", avatarSeed: "jack" }
  },
  {
    id: 104,
    text: "best programming language?",
    type: 'mc',
    options: ["JavaScript", "Python", "Rust", "Go", "C++"],
    comments: 203,
    shares: 67,
    likes: 489,
    author: { name: "kate", avatarSeed: "kate" }
  },
  {
    id: 105,
    text: "coffee or tea?",
    type: 'mc',
    options: ["Coffee", "Tea"],
    comments: 112,
    shares: 34,
    likes: 298,
    author: { name: "leo", avatarSeed: "leo" }
  }
];

export interface MockAnswer {
  id: number;
  text: string;
  questionText: string;
  likes: number;
  author: {
    name: string;
    avatarSeed: string;
  };
}

export const mockAnswers: MockAnswer[] = [
  {
    id: 1,
    text: "I try to eat mostly whole foods, lots of veggies and protein.",
    questionText: "how would you describe your everyday diet?",
    likes: 5,
    author: { name: "zara", avatarSeed: "zara" }
  },
  {
    id: 2,
    text: "Twice, and it was beautiful both times.",
    questionText: "how many times have you fallen in love?",
    likes: 12,
    author: { name: "yann", avatarSeed: "yann" }
  },
  {
    id: 3,
    text: "Too many to count... probably around 50.",
    questionText: "how many browser tabs do you have open rn?",
    likes: 3,
    author: { name: "xena", avatarSeed: "xena" }
  }
];

export const mockPopularAnswers: MockAnswer[] = [
  {
    id: 101,
    text: "42, obviously.",
    questionText: "what is the meaning of life?",
    likes: 1042,
    author: { name: "will", avatarSeed: "will" }
  },
  {
    id: 102,
    text: "Cats. They are independent and fluffy.",
    questionText: "cats or dogs?",
    likes: 856,
    author: { name: "violet", avatarSeed: "violet" }
  },
  {
    id: 103,
    text: "Absolutely not. It's a crime against humanity.",
    questionText: "pineapple on pizza?",
    likes: 500,
    author: { name: "ursula", avatarSeed: "ursula" }
  }
];
