# Qbase Homepage Redesign Plan

## 1. Vision & aesthetic Direction
**Theme:** "The Digital Soul"
**Vibe:** Sophisticated, Deep, Futurist, Ephemeral but Permanent.
- **Color Palette** (matches existing Qbase design system):
  - Light mode: Sky blue `#BFEAF5` → Ivory `#FDFBF7` → Slate `#E2E8F0` gradient
  - Dark mode: Deep navy `#0f172a` → Dark slate `#1e293b` → Medium slate `#334155`
  - Accent: `#7dd3fc` (light) / `#38bdf8` (dark) for CTAs and highlights
  - Nodes: Accent blue for public, muted slate for private, soft ivory for anonymous, emerald for allowlist
- **Background**: 
  - 135° gradient across sky → ivory → slate
  - Subtle noise texture overlay (5% opacity, multiply blend)
  - Particle field suggesting a larger network
**Typography:** Albert Sans (Clean, friendly) mixed with a Monospace font (Data, Code) for technical accents.

---

## 2. Section Breakdown

### Section 1: The Hero - "The Nexus"
**Goal:** Immediate awe and clarity on the "Personal Context Layer".

*   **Visual:** A stunning, interactive WebGL 3D constellation. Thousands of floating "nodes" (particles).
    *   *Interaction:* When the user moves their mouse, nearby nodes light up and connect, forming a unique constellation. This represents the "User's Graph".
    *   *Micro-text:* Occasional floating text snippets from the protocol: "Canon ID: 8821", "Access: Public", "Encrypted".
*   **Copy:**
    *   **H1:** The Personal Context Layer.
    *   **Sub:** Write once. Answer forever. The API for your digital self.
    *   **CTA Primary:** "Claim Your Context" (Glowing Button)
    *   **CTA Secondary:** "Read the Philosophy" (Ghost Button)

### Section 2: The Problem - "Fragmented Identity"
**Goal:** Illustrate the pain of scattered data vs. the Qbase solution.

*   **Visual:**
    *   *Left Side (The Old Way):* Gray, static, disconnected islands. Icons of Facebook, Google, LinkedIn with "Wall" icons around them.
    *   *Right Side (The Qbase Way):* A glowing stream of light (The User) flowing effortlessly through "gates" (Agents, Apps).
*   **Copy:**
    *   **Headline:** Stop Repeating Yourself.
    *   **Body:** Your identity is scattered across dozens of platforms, locked in silos. Every new AI starts from zero. Qbase unifies your digital self into a single, portable, encrypted source of truth.

### Section 3: The Mechanics - "Privacy by Design" (Powered by Nillion)
**Goal:** rigorous explanation of the visibility tiers (Public, Private, Anonymous).

*   **Visual:** Three interactive cards that tilt on hover (3D effect).
    *   *Card 1 (Public):* **Reputation**. Icon: An Eye. "Show the world who you are."
    *   *Card 2 (Anonymous):* **Truth**. Icon: A Ghost. "The Anti-LinkedIn. Share hot takes without the blowback."
    *   *Card 3 (Private):* **Vault**. Icon: A Shield/Padlock. "For your eyes and your agents only."
*   **Animation:** As you hover over 'Anonymous', the card glitched slightly or turns semi-transparent. 'Private' locks with a metallic sound effect.

### Section 4: Open Sociology - "The Collective Mind"
**Goal:** Explain the "Society" value prop.

*   **Visual:** A dynamic "Live Data" visualization. "What does the world think?"
    *   A massive, scrolling ticker or heatmap of real-time questions being answered ( Anonymized).
    *   Example: "42% of users believe AI is conscious."
*   **Copy:**
    *   **Headline:** Open Sociology for the Age of AI.
    *   **Body:** Your answers contribute to a public good. We're mapping human beliefs at scale—without surveillance. Aggregate insights belong to everyone.

### Section 5: The Agent Future - "Context is King"
**Goal:** Show the utility for AI agents.

*   **Visual:** A split chat interface.
    *   *Scenario:* User asks an AI "Plan a weekend trip."
    *   *Without Qbase:* AI asks 10 questions about budget, preferences, location.
    *   *With Qbase (Animated):* A "Context Injection" beam zaps into the chat. AI says: "I know you love hiking, hate crowds, and have a budget of $500. Here's your perfect itinerary."
*   **Copy:**
    *   **Headline:** Give your AI a Soul.
    *   **Body:** A permissioned context layer that any authorized AI can access. No more cold starts.

### Section 6: Footer & Roadmap
*   **Links:** "Manifesto", "Docs", "Twitter/X", "Farcaster".
*   **Badge:** "Secured by Nillion". "Built on Base".

---

## 3. Implementation Details

### Tech Stack
*   **Framework:** React (Vite)
*   **Styling:** TailwindCSS + Framer Motion (for animations).
*   **3D Extras:** React Three Fiber (for the Hero constellation).

### Key Animations (Framer Motion)
1.  **Staggered Fade-in:** Text elements shouldn't just appeal; they should decode (random characters turning into final letters).
2.  **Parallax:** Background layers move at different speeds.
3.  **Scroll Progress:** A thin glowing line traces the left edge of the screen as you scroll, connecting the sections like a timeline.

### Content Strategy (from Docs)
*   Use quotes from `philosophy.md` as interstitials (e.g., *"Open sociology for the age of AI"*).
*   Emphasize the "Write Once, Answer Forever" mantra.
