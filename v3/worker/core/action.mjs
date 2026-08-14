import {normalizeToolbarClick} from './preference-migrations.mjs';

const normalizeActionCommand = click => {
  return normalizeToolbarClick(click).slice('click.'.length);
};

const actionCommand = async storage => {
  const {click = 'click.popup'} = await storage({
    'click': 'click.popup'
  });

  return normalizeActionCommand(click);
};

const actionPopup = click => normalizeActionCommand(click) === 'popup' ? '/data/popup/index.html' : '';

export {actionCommand, actionPopup, normalizeActionCommand};
