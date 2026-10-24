import React from 'react';
import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { colors } from '@/lib/theme';

function TabIcon({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;
}
const icon = (glyph: string) => {
  const Icon = ({ color }: { color: ColorValue }) => <TabIcon glyph={glyph} color={color} />;
  Icon.displayName = `TabIcon(${glyph})`;
  return Icon;
};

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
      tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border }, tabBarActiveTintColor: colors.accent, tabBarInactiveTintColor: colors.muted,
      sceneStyle: { backgroundColor: colors.bg },
    }}>
      <Tabs.Screen name="home" options={{ title: 'Tonight', tabBarIcon: icon('●') }} />
      <Tabs.Screen name="friends" options={{ title: 'Friends', tabBarIcon: icon('◎') }} />
      <Tabs.Screen name="history" options={{ title: 'History', tabBarIcon: icon('≡') }} />
    </Tabs>
  );
}
