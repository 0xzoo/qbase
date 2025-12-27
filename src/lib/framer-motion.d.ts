/* eslint-disable @typescript-eslint/no-explicit-any */
// Type definitions for framer-motion shims
declare module 'framer-motion' {
  export interface MotionProps {
    initial?: any;
    animate?: any;
    exit?: any;
    transition?: any;
    variants?: any;
    whileHover?: any;
    whileTap?: any;
    whileInView?: any;
    whileFocus?: any;
    whileDrag?: any;
    viewport?: any;
    layout?: any;
    layoutId?: string;
    // Animation callbacks
    onAnimationStart?: (definition: any) => void;
    onAnimationComplete?: (definition: any) => void;
    // Style
    style?: React.CSSProperties;
    className?: string;
    [key: string]: any;
  }

  type ComponentType = React.ComponentType<any>;

  export interface MotionComponentConfig {
    forwardMotionProps?: boolean;
  }

  // Motion as both function and object
  interface MotionFunctions {
    <T extends keyof JSX.IntrinsicElements>(component: T): React.ForwardRefExoticComponent<JSX.IntrinsicElements[T] & MotionProps & React.RefAttributes<Element>>;
    <T extends React.ComponentType<any>>(component: T): React.ForwardRefExoticComponent<React.ComponentProps<T> & MotionProps & React.RefAttributes<any>>;
  }

  // Motion object with all HTML elements
  interface MotionComponents extends MotionFunctions {
    div: React.ForwardRefExoticComponent<JSX.IntrinsicElements['div'] & MotionProps & React.RefAttributes<HTMLDivElement>>;
    svg: React.ForwardRefExoticComponent<JSX.IntrinsicElements['svg'] & MotionProps & React.RefAttributes<SVGSVGElement>>;
    path: React.ForwardRefExoticComponent<JSX.IntrinsicElements['path'] & MotionProps & React.RefAttributes<SVGPathElement>>;
    line: React.ForwardRefExoticComponent<JSX.IntrinsicElements['line'] & MotionProps & React.RefAttributes<SVGLineElement>>;
    circle: React.ForwardRefExoticComponent<JSX.IntrinsicElements['circle'] & MotionProps & React.RefAttributes<SVGCircleElement>>;
    g: React.ForwardRefExoticComponent<JSX.IntrinsicElements['g'] & MotionProps & React.RefAttributes<SVGGElement>>;
    h1: React.ForwardRefExoticComponent<JSX.IntrinsicElements['h1'] & MotionProps & React.RefAttributes<HTMLHeadingElement>>;
    h2: React.ForwardRefExoticComponent<JSX.IntrinsicElements['h2'] & MotionProps & React.RefAttributes<HTMLHeadingElement>>;
    p: React.ForwardRefExoticComponent<JSX.IntrinsicElements['p'] & MotionProps & React.RefAttributes<HTMLParagraphElement>>;
    button: React.ForwardRefExoticComponent<JSX.IntrinsicElements['button'] & MotionProps & React.RefAttributes<HTMLButtonElement>>;
    ul: React.ForwardRefExoticComponent<JSX.IntrinsicElements['ul'] & MotionProps & React.RefAttributes<HTMLUListElement>>;
  }

  export const motion: MotionComponents;

  export interface AnimatePresenceProps {
    children?: React.ReactNode;
    initial?: boolean;
    exitBeforeEnter?: boolean;
    mode?: 'wait' | 'sync' | 'popLayout';
    onExitComplete?: () => void;
    custom?: any;
  }

  export const AnimatePresence: React.FC<AnimatePresenceProps>;

  export interface UseInViewOptions {
    root?: Element | Document;
    margin?: string;
    amount?: 'some' | 'all' | number;
    once?: boolean;
  }

  export function useInView(options?: UseInViewOptions): [React.RefObject<Element>, boolean];

  export interface AnimationControls {
    start: (definition: any) => Promise<any>;
    stop: () => void;
    set: (definition: any) => void;
  }

  export function useAnimation(): AnimationControls;

  export type Variant = any;
  export type Variants = { [key: string]: Variant };

  export function useMotionValue<T = any>(initial: T): {
    get(): T;
    set(v: T): void;
    getPrevious(): T;
    on(event: string, callback: (v: T) => void): () => void;
  };

  export function useTransform<I, O>(
    value: { get(): I },
    inputRange: number[],
    outputRange: O[],
    options?: any
  ): { get(): O };

  export interface SpringOptions {
    stiffness?: number;
    damping?: number;
    mass?: number;
    velocity?: number;
    restSpeed?: number;
    restDelta?: number;
  }

  export function useSpring(
    source: number | { get(): number },
    config?: SpringOptions
  ): { get(): number };

  export const LazyMotion: React.FC<{
    features: any;
    strict?: boolean;
    children: React.ReactNode;
  }>;

  export function domAnimation(): any;
  export function domMax(): any;
}
