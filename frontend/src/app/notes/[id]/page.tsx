import MeetingOnlyRoute from '../../settings/page';
export function generateStaticParams() {
  return ['team-sync-dec-26', 'product-review', 'project-ideas', 'action-items'].map(id => ({ id }));
}
export default function LegacyNotesPage() { return <MeetingOnlyRoute />; }
