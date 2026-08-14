import {helperMetadata} from '../../core/helper-metadata.mjs';

// localization
[...document.querySelectorAll('[data-i18n]')].forEach(e => {
  e[e.dataset.i18nValue || 'textContent'] = chrome.i18n.getMessage(e.dataset.i18n);
});

const nonce = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
helperMetadata.take(nonce).then(metadata => {
  document.title = chrome.i18n.getMessage('blank_header') + (metadata?.title ? ` ${metadata.title}` : '');
  if (metadata?.favicon) {
    const link = document.createElement('link');
    link.setAttribute('rel', 'icon');
    link.setAttribute('href', metadata.favicon);
    document.head.appendChild(link);
  }
}).catch(() => {
  document.title = chrome.i18n.getMessage('blank_header');
});

chrome.runtime.onMessage.addListener(request => {
  if (request.method === 'tab-is-active') {
    window.close();
  }
});
document.addEventListener('click', () => window.close());

// close this window if it is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    window.close();
  }
});
