import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { jsx } from 'react/jsx-runtime';
import { makeBalanceBubble } from '../../src/client/bubble.ts';
import { injectPetCss } from '../../src/client/pet/css.ts';
import { makeTodoBubble } from '../../src/client/todo-bubble.ts';

injectPetCss();
makeBalanceBubble({ h: jsx, useEffect, useState });
const TodoBubble = makeTodoBubble({ h: jsx, useEffect, useRef });
const pet = document.querySelector('.dsh-pet-root');
createRoot(pet).render(jsx(TodoBubble, { on: true, onClose: () => {} }));
