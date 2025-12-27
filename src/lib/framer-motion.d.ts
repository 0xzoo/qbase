declare module 'framer-motion' {
  import * as React from 'react';

  export interface AnimationProps {
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
    style?: React.CSSProperties;
    onAnimationStart?: (definition: any) => void;
    onAnimationComplete?: (definition: any) => void;
  }

  export type Variant = {
    [key: string]: any;
  };

  export type Variants = {
    [key: string]: Variant;
  };

  export type MotionProps<P = {}> = P & AnimationProps;

  export const motion: {
    [K in keyof JSX.IntrinsicElements]: React.ForwardRefExoticComponent<
      MotionProps<JSX.IntrinsicElements[K]> & React.RefAttributes<any>
    >;
  };

  export * from 'framer-motion/dist/index';
}

