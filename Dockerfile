FROM node:24

WORKDIR /home/node/app

COPY package*.json ./

RUN npm install
RUN npm update

COPY . .

CMD [ "npm", "start" ]