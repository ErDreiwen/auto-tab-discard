const ACTIONS = new Set([
  'popup',
  'discard-tab',
  'discard-tabs',
  'release-tabs',
  'discard-window',
  'release-window',
  'discard-other-windows',
  'release-other-windows',
  'toggle-allowed'
]);

const normalizeActionCommand = click => {
  const value = typeof click === 'string' ? click : 'click.popup';
  const command = value.startsWith('click.') ? value.slice('click.'.length) : value;

  return ACTIONS.has(command) ? command : 'popup';
};

const actionCommand = async storage => {
  const {click = 'click.popup'} = await storage({
    'click': 'click.popup'
  });

  return normalizeActionCommand(click);
};

const actionPopup = click => normalizeActionCommand(click) === 'popup' ? '/data/popup/index.html' : '';

export {actionCommand, actionPopup, normalizeActionCommand};
