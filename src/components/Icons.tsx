import React from "react";

const svgProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconActivity: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
);
export const IconLocation: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M12 21s7-5.5 7-11a7 7 0 10-14 0c0 5.5 7 11 7 11z" /><circle cx="12" cy="10" r="2.6" /></svg>
);
export const IconDistance: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="28" height="18" viewBox="0 0 48 24" {...svgProps} {...props}><path d="M12 21s7-5.5 7-11a7 7 0 10-14 0c0 5.5 7 11 7 11z" /><circle cx="12" cy="10" r="2.6" /><path d="M36 21s7-5.5 7-11a7 7 0 10-14 0c0 5.5 7 11 7 11z" /><circle cx="36" cy="10" r="2.6" /><line x1="12" y1="21" x2="36" y2="21" strokeDasharray="3,3" /></svg>
);
export const IconClock: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
);
export const IconSport: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
);
export const IconSpeed: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M13 2L4 14h7l-1 8 10-12h-7l1-8z" /></svg>
);
export const IconHeart: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0016.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 002 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" /></svg>
);
export const IconMountain: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><path d="m8 3 4 8 5-5 5 15H2L8 3z" /></svg>
);
export const IconDevice: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><rect x="5" y="2" width="14" height="20" rx="2" /><line x1="12" y1="18" x2="12" y2="18" /></svg>
);
export const IconAvg: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><line x1="4" y1="20" x2="20" y2="4" /><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /></svg>
);
export const IconCadence: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" /><path d="M12 4v3" /><path d="M20 12h-3" /><path d="M12 20v-3" /><path d="M4 12h3" /></svg>
);
export const IconCrank: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" /><path d="M12 7v1.5" /><path d="M17 12h-1.5" /><path d="M12 17v-1.5" /><path d="M7 12h1.5" /><line x1="6.5" y1="6.5" x2="17.5" y2="17.5" /><line x1="5" y1="6.5" x2="8" y2="6.5" /><line x1="16" y1="17.5" x2="19" y2="17.5" /></svg>
);
export const IconBattery: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><rect x="2" y="7" width="18" height="10" rx="2" /><line x1="22" y1="11" x2="22" y2="13" /><path d="M8 10l3 2-3 2" /><path d="M14 10v4" /></svg>
);
export const IconSearch: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
);
export const IconSort: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><line x1="6" y1="7" x2="18" y2="7" /><line x1="9" y1="12" x2="18" y2="12" /><line x1="12" y1="17" x2="18" y2="17" /></svg>
);
export const IconSortDirection: React.FC<{ direction: "asc" | "desc" } & React.SVGProps<SVGSVGElement>> = ({ direction, ...props }) => {
  return direction === "asc"
    ? <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><polyline points="7 11 12 6 17 11" /><line x1="12" y1="18" x2="12" y2="7" /></svg>
    : <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><polyline points="7 13 12 18 17 13" /><line x1="12" y1="6" x2="12" y2="17" /></svg>;
};
export const IconMenu: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" /></svg>
);
export const IconSun: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...svgProps} {...props}><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
);
export const IconMoon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></svg>
);
export const IconSettings: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...svgProps} {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>
);
export const IconLogout: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
);
export const IconRefresh: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
);
export const IconChevron: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}><polyline points="9 18 15 12 9 6" /></svg>
);
export const IconCollapse: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><polyline points="11 17 6 12 11 7" /><polyline points="18 17 13 12 18 7" /></svg>
);
export const IconExpand: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><polyline points="13 17 18 12 13 7" /><polyline points="6 17 11 12 6 7" /></svg>
);
export const IconPower: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M13 2L4 14h7l-1 8 10-12h-7l1-8z" /></svg>
);
export const IconEdit: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
);
export const IconTrash: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
);
export const IconCheck: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><polyline points="20 6 9 17 4 12" /></svg>
);
export const IconX: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
);
export const IconDownload: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
);
export const IconFile: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
);
export const IconBarChart: React.FC<{ size?: number } & React.SVGProps<SVGSVGElement>> = ({ size = 32, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
);
export const IconClipboard: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /></svg>
);
export const IconFlame: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 11-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 002.5 2.5z" /></svg>
);
export const IconVo2: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...props}><path fill="currentColor" d="M4.882 19q-1.203 0-2.042-.854Q2 17.293 2 16.073v-4.161q0-1.007.433-1.886q.433-.878 1.223-1.487l4.113-3.227q.427-.333.656-.813t.229-1.026V2h1v1.473q0 .546.238 1.026t.672.813l4.094 3.226q.784.61 1.217 1.488q.433.879.433 1.885v.32h-1v-.32q0-.763-.339-1.43t-.927-1.15L11.54 7.375v10.987q-.489-.373-.748-.951q-.258-.578-.252-1.338V6.608L9.154 5.48L7.75 6.608v9.465q.006 1.212-.83 2.07T4.882 19m.009-1q.784 0 1.325-.571t.534-1.356V7.375L4.266 9.331q-.608.483-.937 1.15Q3 11.149 3 11.911v4.162q0 .804.553 1.366q.553.561 1.338.561m8.801 1q-.31 0-.539-.23t-.23-.54v-3.845q0-.31.23-.54t.54-.23h2.346q.309 0 .539.23t.23.54v3.846q0 .31-.23.54q-.23.229-.54.229zm.116-.885h2.115V14.5h-2.115zM18.192 21v-2.366q0-.326.222-.548q.22-.22.548-.22h2.269V16.5h-3.039v-.885h3.154q.327 0 .548.222q.222.22.222.548v1.596q0 .327-.222.548q-.221.221-.548.221h-2.269v1.366h3.038V21zm-4.769-8.315"/></svg>
);
export const IconBug: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M20 8h-2.2a6.9 6.9 0 00-1.3-1.3l1.1-1.9-1.7-1-1.1 1.9a7.3 7.3 0 00-2.7-.6 7.3 7.3 0 00-2.7.6L8.3 3.8l-1.7 1 1.1 1.9A6.9 6.9 0 006.4 8H4v2h2v2H4v2h2v2a6 6 0 006 6 6 6 0 006-6v-2h2v-2h-2v-2h2z" /><circle cx="10" cy="11" r="1" /><circle cx="14" cy="11" r="1" /><path d="M9.5 15c.8.7 1.6 1 2.5 1 .9 0 1.7-.3 2.5-1" /></svg>
);
export const IconDiscord: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}><path d="M20.317 4.369A19.791 19.791 0 0015.39 2.8a14.99 14.99 0 00-.678 1.367 18.27 18.27 0 00-5.424 0A14.9 14.9 0 008.61 2.8a19.736 19.736 0 00-4.928 1.57C.564 9.092-.282 13.695.141 18.234a19.91 19.91 0 006.034 2.966c.489-.67.924-1.378 1.294-2.119a12.777 12.777 0 01-2.037-.978c.172-.126.339-.257.501-.39a14.165 14.165 0 0012.134 0c.162.133.329.264.501.39-.649.382-1.33.709-2.038.978.37.74.805 1.448 1.295 2.118a19.88 19.88 0 006.033-2.965c.496-5.263-.845-9.823-3.541-13.865zM9.75 15.081c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.951-2.418 2.157-2.418 1.215 0 2.166 1.095 2.157 2.418 0 1.334-.951 2.419-2.157 2.419zm4.5 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.951-2.418 2.157-2.418 1.214 0 2.166 1.095 2.157 2.418 0 1.334-.943 2.419-2.157 2.419z" /></svg>
);
export const IconGlobe: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 010 20" /><path d="M12 2a15 15 0 000 20" /></svg>
);
export const IconMail: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
);

export const IconUser: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
);

export const IconMetronome: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps} {...props}><path d="M4 20h16" /><path d="M6 20l4-15h4l4 15" /><line x1="12" y1="18" x2="16" y2="7" /><circle cx="14.5" cy="11" r="1.5" /></svg>
);


