import { Redirect } from 'expo-router';
import { useStore } from '@/lib/store';

export default function Index() {
  const session = useStore((s) => s.session);
  return <Redirect href={session ? '/home' : '/sign-in'} />;
}
