/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-empty-object-type */
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

  export function motion<T extends keyof JSX.IntrinsicElements>(component: T): React.ForwardRefExoticComponent<JSX.IntrinsicElements[T] & MotionProps & React.RefAttributes<Element>>;
  export function motion<T extends React.ComponentType<any>>(component: T): React.ForwardRefExoticComponent<React.ComponentProps<T> & MotionProps & React.RefAttributes<any>>;

  export const motion: {
    [K in keyof JSX.IntrinsicElements]: React.ForwardRefExoticComponent<JSX.IntrinsicElements[K] & MotionProps & React.RefAttributes<Element>>;
  } & {
    custom<T extends ComponentType>(component: T): React.ForwardRefExoticComponent<React.ComponentProps<T> & MotionProps & React.RefAttributes<any>>;
  };

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
