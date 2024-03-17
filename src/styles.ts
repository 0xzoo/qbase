export enum colors {
  fcPurple = '#1F1629',
  offBlack = '#231F20',
  baseBlue = '#2151F5',
  anonRed = '#F64B47'
}

export const backgroundStyles: Hono.CSSProperties = {
  backgroundSize: '100% 100%',
  display: 'flex',
  flexDirection: 'column',
  flexWrap: 'nowrap',
  height: '100%',
  width: '100%',
  padding: '5%',
  fontFamily: 'helveticaBlack',
}

export const homeStyles: Hono.CSSProperties = {
  justifyContent: 'center',
  textAlign: 'center',
  backgroundColor: colors.fcPurple,
  alignItems: 'center',
}

export const avatarStyles: Hono.CSSProperties = {
  height: '369px',
  width: '369px',
  borderRadius: '50%',
}

export const amaStyles: Hono.CSSProperties = {
  color: 'white',
  fontSize: 90,
  fontWeight: 600,
  letterSpacing: '-0.025em',
  lineHeight: 1.4,
  marginLeft: 60,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-around',
  fontFamily: 'helveticaBlack',
}

export const titleStyles: Hono.CSSProperties = {
  color: 'white',
  fontSize: 69,
  fontWeight: 700,
  letterSpacing: '-0.025em',
  lineHeight: 1.4,
  marginLeft: 60,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-around',
}

export const qSuccessStyles: Hono.CSSProperties = {
  justifyContent: 'space-between',
  backgroundColor: 'white',
}

export const qContainerStyles: Hono.CSSProperties = {
  letterSpacing: '-0.005em',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  whiteSpace: 'wrap',
  height: '900px',
  width: '98%',
  // borderBottom: '1px #000',
  overflow: 'hidden',
}

export const qStyles: Hono.CSSProperties = {
  color: colors.fcPurple,
  textAlign: 'left',
  // maxWidth: '1180px',
  fontSize: 69,
  fontWeight: 600,
  lineHeight: 1.3,
  marginTop: 'auto',
  marginBottom: 'auto',
  fontFamily: 'helveticaBlack',
}

export const qFooterStyles: Hono.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between'
}

export const askedByStyles: Hono.CSSProperties = {
  display: 'flex',
  fontSize: 33,
  fontWeight: 400,
  letterSpacing: '-0.025em',
  lineHeight: 1,
  marginLeft: '6px',
  marginTop: '30px',
  fontFamily: 'helvetica',
}

export const ownerStyles: Hono.CSSProperties = {
  color: colors.fcPurple,
  marginLeft: '7px',
}

export const warningStyles: Hono.CSSProperties = {
  position: 'absolute',
  bottom: 20,
  color: '#5E6773',
  fontSize: 28,
  textAlign: 'center',
  lineHeight: 1.3,
}