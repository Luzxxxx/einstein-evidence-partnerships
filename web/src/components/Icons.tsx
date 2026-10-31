type Props = { name: 'spark' | 'search' | 'book' | 'activity' | 'close' | 'chevron' | 'arrow' | 'check' | 'source' | 'stop'; size?: number };
const paths: Record<Props['name'], string> = {
  spark: 'M12 3v5m0 8v5M3 12h5m8 0h5M5.6 5.6l3.5 3.5m5.8 5.8 3.5 3.5M5.6 18.4l3.5-3.5m5.8-5.8 3.5-3.5',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  book: 'M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3V4m9 2v16',
  activity: 'M2 12h4l3-8 6 16 3-8h4',
  close: 'm6 6 12 12M6 18 18 6', chevron: 'm9 5 7 7-7 7', arrow: 'M4 12h16m-6-6 6 6-6 6',
  check: 'm4 12 5 5L20 6', source: 'M9 4H4v16h16v-5M14 3h7v7m0-7L10 14', stop: 'M6 6h12v12H6z',
};
export function Icon({ name, size = 20 }: Props) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function BrandMark() {
  return <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M8 8 24 16 8 24V8Z" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="8" r="4" fill="currentColor" /><circle cx="24" cy="16" r="4" fill="currentColor" /><circle cx="8" cy="24" r="4" fill="currentColor" /></svg>;
}
