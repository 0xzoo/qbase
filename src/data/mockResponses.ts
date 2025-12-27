export interface Response {
  id: number;
  questionId: number;
  text: string;
  username: string;
}

export const mockResponses: Response[] = [
  {
    id: 1,
    questionId: 2, // "how many times have you fallen in love?"
    text: "1. The Expanse 2. Mr. Robot 3. Star Trek TNG",
    username: "@zoo"
  },
  {
    id: 2,
    questionId: 2,
    text: "lost, saul goodman or the wire",
    username: "@catch0x22"
  },
  {
    id: 3,
    questionId: 2,
    text: "community, x files, and chernobyl",
    username: "@m-j-r.eth"
  },
  {
    id: 4,
    questionId: 1,
    text: "Mostly plant based, but I love cheese too much.",
    username: "@veggie_lover"
  }
];
