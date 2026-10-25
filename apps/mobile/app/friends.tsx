import React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { FriendsList } from '@/components/pip/FriendsList';
import { Brand, D, Icon, IconBtn, T } from '@/components/pip/kit';
import { usePeople } from '@/components/pip/usePeople';
import { ui } from '@/lib/theme';

/** Everyone's status, full screen (the home screen shows the same list as a sidebar). */
export default function Friends() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { me, others, counts } = usePeople();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <View style={[styles.column, { width: Math.min(width, 520) }]}>
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <IconBtn label="Back" onPress={back}>{Icon.back()}</IconBtn>
          <Brand size={24} />
          <IconBtn label="Add a friend" onPress={() => router.push('/groups')}>{Icon.plus()}</IconBtn>
        </View>
        <FriendsList
          me={me} others={others}
          style={{ flex: 1, paddingHorizontal: 22 }}
          bottomInset={insets.bottom + 24}
          onOpen={(id) => router.push(`/friend/${encodeURIComponent(id)}`)}
          onGroups={() => router.push('/groups')}
          onHistory={() => router.push('/history')}
          onSettings={() => router.push('/settings')}
          header={(
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 18 }}>
              <D accessibilityRole="header" style={{ fontSize: 40, lineHeight: 44 }}>Friends</D>
              <T style={{ fontSize: 13, lineHeight: 18, color: ui.quiet }}>{counts.out} out · {counts.home} home</T>
            </View>
          )}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.ground, alignItems: 'center' },
  column: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 },
});
