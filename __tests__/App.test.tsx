/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

jest.mock('../src/fog/fogNode', () => ({
  BASE_URL: 'https://api.mangoon.xyz',
  fogNode: {
    subscribe: () => () => {},
    unsubscribe: () => {},
    start: () => Promise.resolve(),
    stop: () => {},
  },
}));

test('renders correctly', async () => {
  await ReactTestRenderer.act(async () => {
    ReactTestRenderer.create(<App />);
    await Promise.resolve();
  });
});
