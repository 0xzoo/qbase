export type Social = "x" | "farcaster"

export type User = {
  id: number,
  fName: string,
  createdAt: number
  fId?: number,
  pointsBalance: number,
  pointsAllowance: number,
  socials: Social[]
}